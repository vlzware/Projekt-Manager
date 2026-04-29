#!/usr/bin/env bash
#
# Destructively overwrite the VPS's Postgres database and Backblaze B2
# bucket with whatever is currently in the operator's local dev stack. See
# docs/ops/sync-dev-to-vps.md for the runbook, preconditions, and failure
# modes.
#
# Why this exists: the /api/export → /api/import flow carries only business
# data (customers/projects/assignments) and validates createdBy/updatedBy
# refs against the target user table — so any sync through that API path
# has to manually reconstruct the same user UUIDs on the VPS first.
# Dumping the whole DB sidesteps that entirely and also carries attachment
# rows that match the bucket objects we mirror alongside it.
#
# Topology note: dev mirrors prod through MinIO via docker-compose.minio.yml
# (ADR-0022 / ddff944). Locally we read the dump from MinIO; on the VPS we
# write the mirror to B2. The dump-and-mirror logic stays bucket-shape-only;
# the only provider-specific code lives in scripts/ops/sync-restore-vps.sh.
#
# Usage:
#   scripts/sync-dev-to-vps.sh            # runs preflight only, then refuses
#   scripts/sync-dev-to-vps.sh --i-know   # proceeds after preflight
#
# Preconditions (enforced):
#   - ssh hetzner is reachable as the deploy user
#   - local docker compose stack has `db` and `storage` running (the
#     `storage` service is the dev MinIO mirror)
#   - the local dev overlay is in use (docker-compose.dev.yml +
#     docker-compose.minio.yml)
#   - the baseline migration hash matches between local and VPS — i.e. the
#     VPS is deployed at a commit with a compatible schema. If not, deploy
#     the matching commit first (docs/ops/manual-deploy.md) and retry.
#
# What gets overwritten on the VPS:
#   - Postgres database `projekt_manager` (all tables DROPped and recreated
#     from the local dump — includes users, sessions, audit logs, etc.)
#   - B2 bucket configured as STORAGE_BUCKET in the VPS app env (mirrored;
#     keys not present locally get a delete-marker on B2, original versions
#     are preserved by Compliance Object Lock per ADR-0022)
#
# What does NOT get touched:
#   - VPS filesystem, secrets, Caddy, backup cron state
#   - VPS-issued VAPID keys (stored outside the DB — unaffected)
#   - Older B2 versions of any object — `--remove` and `--overwrite` both
#     create new versions / delete markers; nothing is destroyed.

set -euo pipefail

SSH_TARGET="${SSH_TARGET:-hetzner}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Local MinIO bucket name — the VPS bucket name lives in the VPS app
# container's env (read by scripts/ops/sync-restore-vps.sh) since prod is
# Backblaze B2 with an operator-chosen bucket name (typically
# `prmng-object-storage`).
LOCAL_BUCKET="projekt-manager"
COMPOSE_PROJECT="projekt-manager"
# Must match docker/init-storage.sh (same image, so we rely on it being
# present on the VPS — it was pulled on the first deploy that ran
# storage-init). Keeping this in sync with the compose file is a manual
# discipline; a tag drift here would mean a mirror against an older client.
MC_IMAGE="minio/mc:RELEASE.2025-08-13T08-35-41Z"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_TMP="/tmp/pm-sync-$TS"
REMOTE_TMP="/tmp/pm-sync-$TS"
REMOTE_SCRIPT="$REPO_DIR/scripts/ops/sync-restore-vps.sh"

I_KNOW=0
for arg in "$@"; do
  case "$arg" in
    --i-know) I_KNOW=1 ;;
    -h|--help)
      sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# Clean up temp on both ends on any exit — including preflight failures, where
# $LOCAL_TMP hasn't been created yet (the `|| true` absorbs that).
cleanup() {
  rm -rf "$LOCAL_TMP" 2>/dev/null || true
  ssh -o BatchMode=yes "$SSH_TARGET" "rm -rf $REMOTE_TMP" 2>/dev/null || true
}
trap cleanup EXIT

echo "[1/9] SSH preflight ($SSH_TARGET)..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" true

echo "[2/9] Local stack check..."
# Use --status running (compose >=2.24) and grep for exact service names. The
# dev overlay must be active; without it, compose would not know about the
# exposed ports that the `docker exec` calls below do NOT actually use — but
# the overlay is also what keeps the developer-facing workflow consistent
# (see docs/ops/local-dev.md). Asserting it here avoids the footgun of
# running against a partial stack.
cd "$REPO_DIR"
running_services=$(docker compose -f docker-compose.yml -f docker-compose.minio.yml -f docker-compose.dev.yml \
  ps --services --status running 2>/dev/null || true)
for svc in db storage; do
  if ! echo "$running_services" | grep -qx "$svc"; then
    echo "ERROR: local service '$svc' is not running." >&2
    echo "  Start the dev stack:" >&2
    echo "    docker compose -f docker-compose.yml -f docker-compose.minio.yml -f docker-compose.dev.yml up -d db storage storage-init" >&2
    exit 1
  fi
done

echo "[3/9] Schema parity check..."
# The schema is canonically `0000_baseline.sql` (see
# MEMORY: "DB schema changes collapse into baseline migration"). Hash-compare
# is the cheapest correct check — if bytes match, Drizzle applies the same
# objects in the same order in both environments.
local_hash=$(sha256sum "$REPO_DIR/src/server/db/migrations/0000_baseline.sql" | awk '{print $1}')
vps_hash=$(ssh "$SSH_TARGET" "sha256sum /opt/projekt-manager/src/server/db/migrations/0000_baseline.sql" | awk '{print $1}')
if [ "$local_hash" != "$vps_hash" ]; then
  cat <<ERR >&2
ERROR: schema hash mismatch — VPS is not deployed at a compatible commit.
  local: $local_hash
  vps:   $vps_hash
Deploy the matching commit first (docs/ops/manual-deploy.md), then retry.
ERR
  exit 1
fi

# Refuse to sync an empty or uninitialised local DB. This catches the
# "volumes wiped, app never restarted since" footgun: migrations + seed
# run from src/server/start.ts at app boot, so if the operator hasn't
# `npm run dev`'d since the last `docker compose down -v`, the DB is bare
# and syncing it would nuke the VPS. Checking users > 0 is a cheap proxy
# for "the app has booted at least once against this DB".
local_user_count=$(docker exec "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d projekt_manager -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users';")
if [ "$local_user_count" != "1" ]; then
  echo "ERROR: local DB has no users table — start the app ('npm run dev') to run migrations + seed, then retry." >&2
  exit 1
fi
local_users=$(docker exec "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d projekt_manager -tAc "SELECT COUNT(*) FROM users;")
if [ "$local_users" -lt 1 ]; then
  echo "ERROR: local users table is empty — nothing to sync. Seed the DB (SEED=force in .env, then restart the app) and retry." >&2
  exit 1
fi

echo "[4/9] Bucket-pollution check..."
# Refuse if the local MinIO bucket holds more current-version objects than
# the DB can justify. Each live attachment row contributes AT MOST orig +
# thumb (2 objects); the +2 slack covers a transient bulk-download zip and
# one stray probe artifact.
#
# Without this guard, orphan debris (E2E test runs, abandoned upload
# flows the orphan reaper couldn't reach) gets faithfully mirrored onto
# B2 — and every PutObject locks for R days under Compliance Object Lock
# retention regardless of any subsequent delete-marker. That is real
# money for no benefit. The threshold is deliberately tight (`2 × rows + 2`)
# because dev should not be hoarding test artifacts; if this trips, clean
# the local bucket per the error message below before retrying.
local_attachment_rows=$(docker exec "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d projekt_manager -tAc \
  "SELECT COUNT(*) FROM attachments WHERE status IN ('pending', 'ready');")
local_bucket_objects=$(docker exec "${COMPOSE_PROJECT}-storage-1" sh -c '
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
  mc ls --recursive --summarize "local/'"$LOCAL_BUCKET"'" 2>/dev/null
' | awk '/^Total Objects:/ {print $3+0; found=1} END {if(!found) print 0}')
expected_max=$((2 * local_attachment_rows + 2))
if [ "$local_bucket_objects" -gt "$expected_max" ]; then
  cat <<ERR >&2
ERROR: local MinIO bucket holds $local_bucket_objects current-version
objects but only $local_attachment_rows live attachment rows (status IN
'pending', 'ready'). Expected ceiling is $expected_max objects
(2 × rows + 2 slack for in-flight bulk-downloads).

This is dev-environment debris — orphan uploads (E2E runs, abandoned
upload flows) the orphan reaper could not reach. Mirroring them onto
B2 costs real money: every PutObject locks for R days under Compliance
Object Lock retention, regardless of any subsequent delete-marker.

Clean the local bucket before syncing:

  docker exec ${COMPOSE_PROJECT}-storage-1 sh -c \\
    'mc alias set local http://localhost:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && mc rm --recursive --force local/${LOCAL_BUCKET}/'

The current-version view goes to zero immediately; noncurrent versions
reap after R+L days per Object Lock + lifecycle (no extra action needed).
Then re-run this script.
ERR
  exit 1
fi

if [ "$I_KNOW" != "1" ]; then
  cat <<MSG >&2
Preflight passed.

This command will DESTRUCTIVELY OVERWRITE on $SSH_TARGET:
  - Postgres database: projekt_manager (all tables dropped and recreated)
  - Object storage:    the VPS B2 bucket configured as STORAGE_BUCKET in
                       the app container env. Keys absent locally get a
                       delete-marker on B2; older versions are preserved
                       by Compliance Object Lock per ADR-0022.

No VPS-side backup is taken by this script. If you need a separate one,
run it through the Layer 2 backup before syncing
(docs/ops/backup/overview.md). The B2 bucket itself is versioned and
Compliance-locked, so this sync's writes are recoverable until R + L
days pass per the bucket's retention configuration.

Re-run with --i-know to proceed.
MSG
  exit 1
fi

mkdir -p "$LOCAL_TMP"

echo "[5/9] Dumping local database..."
# Plain SQL with --clean --if-exists generates DROP TABLE IF EXISTS CASCADE +
# CREATE ... at the top of the dump, which psql applies in order. --no-owner
# and --no-acl skip ALTER OWNER and GRANT/REVOKE statements so the dump does
# not try to re-grant to dev-side roles that do not exist on the VPS (the
# VPS's `pm` role already owns the DB from docker-compose init).
docker exec -i "${COMPOSE_PROJECT}-db-1" \
  pg_dump -U pm -d projekt_manager \
  --clean --if-exists --no-owner --no-acl \
  > "$LOCAL_TMP/db.sql"
echo "      db.sql: $(du -h "$LOCAL_TMP/db.sql" | awk '{print $1}')"

echo "[6/9] Dumping local object storage..."
# Read MinIO credentials from the running storage container's env. Same
# pattern the remote side uses — avoids needing to parse .env here.
LOCAL_MINIO_USER=$(docker exec "${COMPOSE_PROJECT}-storage-1" printenv MINIO_ROOT_USER)
LOCAL_MINIO_PASS=$(docker exec "${COMPOSE_PROJECT}-storage-1" printenv MINIO_ROOT_PASSWORD)

mkdir -p "$LOCAL_TMP/bucket"
# Run mc in a throwaway container joined to the dev compose network so
# `storage:9000` resolves. --remove on the target (a local dir) keeps it an
# exact mirror of the bucket even across repeated runs of this script.
docker run --rm \
  --network "${COMPOSE_PROJECT}_default" \
  -v "$LOCAL_TMP/bucket:/data" \
  -e MC_HOST_src="http://${LOCAL_MINIO_USER}:${LOCAL_MINIO_PASS}@storage:9000" \
  "$MC_IMAGE" \
  mirror --overwrite --remove "src/$LOCAL_BUCKET" /data >/dev/null
echo "      bucket: $(du -sh "$LOCAL_TMP/bucket" | awk '{print $1}') ($(find "$LOCAL_TMP/bucket" -type f | wc -l) files)"

echo "[7/9] Transferring to VPS..."
ssh "$SSH_TARGET" "mkdir -p $REMOTE_TMP"
# Ship the SSOT smoke probe alongside the dump so the streamed
# sync-restore-vps.sh can call it from $REMOTE_TMP. Keeps the smoke probe
# a single file across CI, deploy, and sync — see
# scripts/smoke-app-health.sh for why.
cp "$REPO_DIR/scripts/smoke-app-health.sh" "$LOCAL_TMP/smoke-app-health.sh"
# -a preserves perms/times; -z compresses (SQL and metadata compress well).
# No --delete — REMOTE_TMP is created fresh this run and cleaned up on exit.
rsync -az "$LOCAL_TMP/" "$SSH_TARGET:$REMOTE_TMP/"

echo "[8/9] Restoring on VPS..."
# Stream the remote script over SSH rather than copying it to the VPS. This
# keeps the in-repo copy authoritative and avoids drift between a transferred
# copy and the committed version. Env vars pass configuration; `bash -s`
# reads the script from stdin and runs it in a fresh login shell.
ssh "$SSH_TARGET" \
  "REMOTE_TMP='$REMOTE_TMP' MC_IMAGE='$MC_IMAGE' COMPOSE_PROJECT='$COMPOSE_PROJECT' bash -s" \
  < "$REMOTE_SCRIPT"

echo "[9/9] Done — VPS synced at $(date -u -Iseconds)"
