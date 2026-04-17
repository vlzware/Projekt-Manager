#!/usr/bin/env bash
#
# Manual pull-based deploy for Projekt-Manager.
#
# Run on the VPS by the operator over WireGuard, as the `deploy` user:
#
#   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh                                  # origin/main (default)
#   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/iteration/N-name          # track an iteration branch
#   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh 3721783abc                       # rollback to a specific SHA
#
# The script replaces .github/workflows/deploy.yml. See ADR-0012
# (docs/adr/0012-manual-pull-based-deploy-over-wireguard.md) for the
# rationale behind removing the push-based GHA deploy path. The artifact
# pipeline (CI → GHCR, ADR-0011) is unchanged — this script only replaces
# the distribution-to-host leg.
#
# Preconditions on the VPS:
#   - /opt/projekt-manager is a git clone of vlzware/Projekt-Manager
#   - /opt/projekt-manager/secrets.env.age exists (age-encrypted env file)
#   - The `deploy` user is logged in to GHCR via `docker login`
#   - `age` is installed
#
set -euo pipefail

REF="${1:-origin/main}"
REPO_DIR="/opt/projekt-manager"
SECRETS_FILE="$REPO_DIR/secrets.env.age"

cd "$REPO_DIR"

# Two-phase structure. Phase 1 (DEPLOY_REEXEC unset) fetches, checks out
# the target SHA, and re-execs. Phase 2 (DEPLOY_REEXEC=1) is the rest of
# the deploy, and runs from the target-SHA version of this script.
#
# Why: bash parses `$0` into memory once, at invocation time. The code
# that runs after `git checkout` is still the version bash read BEFORE
# the checkout — which is the *previous* working-tree's deploy.sh, not
# the target SHA's. A roll-forward-then-rollback-then-forward sequence
# silently executes the intermediate SHA's deploy.sh logic on the
# third run (see 2026-04-17 session: first deploy at 773b2b4's
# deploy.sh pulled only `app`; target was e047704 which expected
# `--profile backup pull app backup` — backup image was never pulled
# and the backup service never started; observed as "up 5/5" vs the
# expected 6/6). Re-exec'ing with the newly-checked-out script drives
# the feature matrix from the target SHA, not from whatever happened
# to be on disk at invocation.
if [ "${DEPLOY_REEXEC:-0}" != "1" ]; then
  git fetch origin

  EXPECTED_SHA="$(git rev-parse "$REF")"
  echo "Deploying $REF -> $EXPECTED_SHA"

  # Assert the checkout landed on the expected SHA. Without this, a silently
  # failed checkout (e.g. uncommitted local changes blocking the switch)
  # would continue past with a stale working tree and deploy the wrong code —
  # the exact failure mode hit in iteration 4 (#48 comment 2026-04-08).
  git checkout "$EXPECTED_SHA"
  actual="$(git rev-parse HEAD)"
  if [ "$actual" != "$EXPECTED_SHA" ]; then
    echo "ERROR: git checkout landed at $actual, expected $EXPECTED_SHA" >&2
    exit 1
  fi

  # Hand off to Phase 2 running on the newly-checked-out script. The
  # env flag is both a circuit-breaker (no infinite re-exec loop) and
  # the signal Phase 2 uses to skip the fetch/checkout it already ran.
  export DEPLOY_REEXEC=1
  exec "$0" "$@"
fi

# --- Phase 2 -----------------------------------------------------------
# We are guaranteed to be running the target SHA's deploy.sh. HEAD was
# moved to EXPECTED_SHA in Phase 1, so `git rev-parse HEAD` recovers it
# without needing Phase 1 to thread state across the exec boundary.
EXPECTED_SHA="$(git rev-parse HEAD)"
echo "(continuing deploy at $EXPECTED_SHA)"

# Decrypt secrets into the shell env. Process substitution keeps plaintext
# off disk — `age -d` writes to an anonymous file descriptor that `source`
# reads and discards. `set -a` auto-exports so the sourced KEY=value lines
# reach `docker compose` without needing an explicit `export` per var.
set -a
# shellcheck disable=SC1090
source <(age -d "$SECRETS_FILE")
set +a

# Pin the exact SHA-tagged image so this deploy is reproducible and a
# rollback is just re-running with an older SHA. `docker compose pull`
# only pulls services that declare an `image:` — `db`, `storage`, and
# `caddy` use their own pinned registry images (unchanged). Both `app`
# and `backup` images are produced by this repo and share APP_IMAGE_TAG
# — CI pushes them as a pair per commit SHA (see
# .github/workflows/ci.yml build-and-push job and ADR-0020 §Decision
# for the backup image).
export APP_IMAGE_TAG="sha-$EXPECTED_SHA"
# --profile backup is needed on BOTH `pull` and `up` — without it on
# pull, the backup service is filtered out of the active set and its
# image is never fetched ahead of `up -d` (which would then block on a
# registry round-trip while starting).
docker compose --profile backup pull app backup
# The backup service is behind a profile so local dev (no R2 creds)
# doesn't spin up a cron loop that will log AccessDenied every 15 min.
# See docs/ops/recovery.md §6 and ADR-0020.
docker compose --profile backup up -d

# Smoke test: probe the app container's /api/health endpoint directly,
# bypassing Caddy and the TLS chain. Verifies app + db + storage are
# healthy without depending on the network-layer topology. Since #48 the
# endpoint runs real liveness probes against the DB (SELECT 1) and object
# storage (HeadBucket), returning {status:"ok"} with HTTP 200 on a fully
# healthy stack and {status:"degraded"} with HTTP 503 when any dependency
# fails. `r.ok` correctly interprets 503 as failure.
timeout=60
elapsed=0
until docker compose exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  sleep 2
  elapsed=$((elapsed + 2))
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "Health check failed after ${timeout}s" >&2
    # Include the backup container in the failure dump — its profile
    # must match `up -d` above, otherwise compose filters it out of
    # the active service set and the logs command silently skips it.
    docker compose --profile backup logs --tail=50
    exit 1
  fi
done

echo "Deploy verified — healthy at $(git rev-parse --short HEAD)"
