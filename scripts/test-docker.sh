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
COMPOSE="docker compose -f $PROJECT_DIR/docker-compose.yml"
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
MINIO_ROOT_USER=testadmin
MINIO_ROOT_PASSWORD=test-safe-password
STORAGE_ENDPOINT=http://storage:9000
STORAGE_BUCKET=projekt-manager
STORAGE_ACCESS_KEY=testadmin
STORAGE_SECRET_KEY=test-safe-password
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
