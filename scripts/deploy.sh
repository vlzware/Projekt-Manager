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
# `caddy` use their own pinned registry images (unchanged). The `app`
# service is the only one whose image is produced by this repo.
export APP_IMAGE_TAG="sha-$EXPECTED_SHA"
docker compose pull app
docker compose up -d

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
    docker compose logs --tail=50
    exit 1
  fi
done

echo "Deploy verified — healthy at $(git rev-parse --short HEAD)"
