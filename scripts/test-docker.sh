#!/usr/bin/env bash
#
# Smoke test for the production Docker Compose stack.
#
# Builds the app image, starts all services, waits for the health
# endpoint, and tears everything down. Verifies that the documented
# "docker compose up" path actually works.
#
# Usage:  ./scripts/test-docker.sh
#
# NOTE: Login cannot be tested because SEED is blocked in production
# mode (NODE_ENV=production) and there is no CLI/API to create the
# initial user. This is tracked as a known gap.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Smoke runs the prod base file + the MinIO mirror overlay (no dev
# overlay — we want the production image path, not `build: .`). The
# minio overlay supplies the in-compose object store + storage-init.
COMPOSE="docker compose -f $PROJECT_DIR/docker-compose.yml -f $PROJECT_DIR/docker-compose.minio.yml"
ENV_FILE="$PROJECT_DIR/.env.docker-test"

cleanup() {
  echo "--- Tearing down ---"
  $COMPOSE --env-file "$ENV_FILE" down -v --remove-orphans 2>/dev/null || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

# Create a temporary .env with non-default credentials so the
# production safety check (rejectDevCredentials) does not fire.
cat > "$ENV_FILE" <<'DOTENV'
NODE_ENV=production
POSTGRES_PASSWORD=test-safe-password
# MinIO root creds — used by the storage / storage-init services in the
# minio overlay. The app NEVER runs as root.
MINIO_ROOT_USER=testadmin
MINIO_ROOT_PASSWORD=test-safe-password
# Capability-restricted MinIO app user (#45 / ADR-0022). docker/init-storage.sh
# provisions this user; the app runs as it. Distinct from the root creds
# above so the boot-time capability self-test exercises the same split as
# prod B2 (writeFiles, readFiles, listFiles — no deleteFiles).
MINIO_APP_ACCESS_KEY=testapp
MINIO_APP_SECRET_KEY=test-safe-app-password
# Object-storage env consumed by the app. The minio overlay overrides
# STORAGE_ENDPOINT / STORAGE_PUBLIC_ENDPOINT / STORAGE_REGION for the
# in-compose MinIO target; this file still has to satisfy the base
# file's `:?` parse-time gates.
STORAGE_ENDPOINT=http://storage:9000
STORAGE_REGION=us-east-1
STORAGE_BUCKET=projekt-manager
STORAGE_ACCESS_KEY=testapp
STORAGE_SECRET_KEY=test-safe-app-password
DOMAIN=localhost
PORT=3000
SEED=false
DOTENV

echo "--- Building app image ---"
$COMPOSE --env-file "$ENV_FILE" build app

echo "--- Starting stack ---"
$COMPOSE --env-file "$ENV_FILE" up -d

echo "--- Waiting for health endpoint (max 60s) ---"
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "Health check passed after ${i}s"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: health check did not pass within 60s"
    $COMPOSE --env-file "$ENV_FILE" logs app
    exit 1
  fi
  sleep 1
done

# Verify response body. #48 upgraded the health probe to report
# per-dependency state; the top-level "status":"ok" only surfaces if both
# the DB and storage liveness checks passed. A degraded state returns 503,
# which the curl -sf above already rejects, so reaching this line means we
# got a 200. Tighten the grep to the specific status field so a future
# schema change that keeps the word "ok" elsewhere cannot mask a
# regression.
HEALTH=$(curl -sf http://localhost:3000/api/health)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo "PASS: health endpoint returned ok"
else
  echo "FAIL: unexpected health response: $HEALTH"
  exit 1
fi

echo "--- Docker production smoke test passed ---"
