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

# --- Pre-flight: env/secrets parity check --------------------------------
# Catch operator-side drift: a new key was added to
# `.env.production.example` or `secrets.manifest.txt` since the last
# time the operator synced, but the deployed `.env` / `secrets.env.age`
# was never updated to match. Without this check the deploy proceeds,
# compose interpolates the missing var as an empty string (bare `${X}`
# has no default), and the app either crash-loops on Zod validation or
# — worse — silently runs misconfigured. Abort BEFORE touching the
# running stack: no pull, no restart, no traffic shift until the
# operator has synced.
#
# Two files, two sources of truth, one assertion each:
#   - `.env.production.example` keys ⊆ `/opt/projekt-manager/.env`
#   - `secrets.manifest.txt` keys  ⊆ (env vars exported above)
#
# The secrets check reads from the current process env (populated by
# the `source <(age -d …)` above) rather than re-parsing the encrypted
# file, so we don't prompt for the passphrase twice.

env_example_keys=""
if [ -f "$REPO_DIR/.env.production.example" ]; then
  env_example_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$REPO_DIR/.env.production.example" \
    | sed 's/=.*$//' | sort -u)
fi

env_actual_keys=""
if [ -f "$REPO_DIR/.env" ]; then
  env_actual_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$REPO_DIR/.env" | sed 's/=.*$//' | sort -u)
fi

if [ -n "$env_example_keys" ]; then
  missing_env=$(comm -23 <(echo "$env_example_keys") <(echo "$env_actual_keys") || true)
  if [ -n "$missing_env" ]; then
    echo "ERROR: $REPO_DIR/.env is missing keys declared in .env.production.example:" >&2
    echo "$missing_env" | sed 's/^/  - /' >&2
    echo "" >&2
    echo "Sync the keys (preserving existing values) before deploying. See" >&2
    echo "docs/ops/manual-deploy.md for the edit-in-place workflow." >&2
    exit 1
  fi
fi

missing_secrets=""
if [ -f "$REPO_DIR/secrets.manifest.txt" ]; then
  while IFS= read -r key; do
    # `${!key+x}` is bash indirection: expands to 'x' when $key names a
    # set variable (even set to empty), empty otherwise. We accept empty
    # values — the manifest only asserts declaration; Zod still rejects
    # malformed values at container start.
    if [ -z "${!key+x}" ]; then
      missing_secrets="${missing_secrets}${key}"$'\n'
    fi
  done < <(grep -E '^[A-Z_][A-Z0-9_]*$' "$REPO_DIR/secrets.manifest.txt")
fi

if [ -n "$missing_secrets" ]; then
  echo "ERROR: secrets.env.age is missing keys declared in secrets.manifest.txt:" >&2
  printf '%s' "$missing_secrets" | sed '/^$/d; s/^/  - /' >&2
  echo "" >&2
  echo "Rotate secrets.env.age to include the missing keys before deploying" >&2
  echo "(docs/ops/manual-deploy.md § Rotate a secret)." >&2
  exit 1
fi

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

# --- Pre-flight: schema-level env validation (AC-231) ----------------
# Run the same `validateEnv()` the boot path uses, BEFORE `docker
# compose up`. The two presence checks above (env_example_keys,
# secrets.manifest.txt) only assert that keys are *declared*; they do
# not catch shape errors (PORT=0, NODE_ENV=staging, SEED=maybe), nor
# the cross-cutting checks the schema folds in (dev-default
# credentials in production). A misconfiguration that gets past the
# presence check would otherwise crash-loop the freshly-recreated
# container — losing the previous-revision's known-good replicas before
# the new replicas are healthy. This step catches it without touching
# the running stack.
#
# Why `docker compose run --rm --no-deps app` (not `docker run`):
#   - The compose `app.environment:` block hardcodes DATABASE_URL,
#     STORAGE_*, NODE_ENV, PORT (built from operator vars via `${VAR}`
#     interpolation). A standalone `docker run` would see only the
#     operator-supplied env (POSTGRES_PASSWORD, ...) and the schema
#     would reject DATABASE_URL as missing — a false positive that
#     does not match what the actual `up` will give the container.
#     `compose run` resolves the same `environment:` block the live
#     container receives, so the validation environment matches the
#     deploy environment exactly.
#   - `--no-deps` skips starting `db` / `storage` (they may already be
#     up, and we don't need them to validate env). `--rm` removes the
#     one-shot container immediately. `-T` disables TTY allocation so
#     the call works in non-interactive deploy contexts (cron, CI).
#   - The CMD `node /app/dist/server/validate-env-cli.js` runs the
#     dedicated validation entry built by `package.json` >
#     `build:server` esbuild target list. validateEnv() prints the
#     aggregated error and exits non-zero on any offence; deploy.sh's
#     `set -euo pipefail` propagates the failure and aborts BEFORE
#     `docker compose up` runs.
echo "Validating env against the deploy image's Zod schema..."
docker compose run --rm --no-deps -T app node /app/dist/server/validate-env-cli.js

# The backup service is behind a profile so local dev (no R2 creds)
# doesn't spin up a cron loop that will log AccessDenied on every
# scheduled tick. See docs/ops/backup/setup.md §4 and ADR-0020.
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

# Caddy graceful reload — re-reads the bind-mounted Caddyfile in place
# so site-block additions (e.g. the `storage.${DOMAIN}` block introduced
# when the storage subdomain wiring landed) take effect on the first
# deploy that ships them.
#
# `docker compose up -d` above only recreates containers whose resolved
# compose stanza differs from the running one; Caddy's stanza is stable
# across most deploys even when its bind-mounted Caddyfile changes. On
# top of that, a file bind-mount pins the container's inode at creation
# time — replacing the on-host file (which is what `git checkout` does
# for any tracked change) leaves the container's file descriptor open on
# the old inode for the current Caddy process lifetime. A `docker restart`
# re-mounts with the new inode but does NOT re-read compose env, so it
# can swap Caddyfile content but keep stale secrets (e.g. CLOUDFLARE_API_TOKEN
# after a rotation). Neither behaviour is obvious enough to remember at
# deploy time.
#
# `caddy reload` sidesteps both by hitting the admin API (bound to
# localhost:2019 inside the container) to re-parse /etc/caddy/Caddyfile
# against the process's current env. Connections stay open across the
# swap. Safe to call every deploy — Caddy exits 0 and logs "config is
# unchanged" when nothing differs.
echo "Reloading Caddy config..."
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force

echo "Deploy verified — healthy at $(git rev-parse --short HEAD)"
