#!/usr/bin/env bash
# One-off: create a long-lived smoke-test account in the production DB (#58).
#
# The smoke E2E test in scripts/smoke-e2e.sh needs a dedicated account it
# can log in with on every deploy. Walking-skeleton scope does not ship a
# user-management UI and the bootstrap mechanism only runs when the users
# table is empty — so this script fills the gap for the one-time creation.
#
# Role: `bookkeeper` — read-only. A leaked smoke credential must NEVER
# grant write access. See `src/server/config/permissions.ts`.
#
# Idempotent: re-running with the same username is a no-op (ON CONFLICT
# DO NOTHING on username). Re-running with the same username and a
# different password does NOT update the password — delete the row
# manually first if you need to rotate.
#
# Usage (run on the VPS, from /opt/projekt-manager):
#
#   SMOKE_TEST_USERNAME=smoke \
#   SMOKE_TEST_PASSWORD='<value from 1password / vault>' \
#   bash scripts/create-smoke-test-user.sh
#
# Prerequisites:
#   - Compose stack is up (db and app containers running)
#   - POSTGRES_PASSWORD is set in /opt/projekt-manager/.env
#
# After running, add the same values to GitHub secrets:
#   gh secret set SMOKE_TEST_USERNAME --body "smoke"
#   gh secret set SMOKE_TEST_PASSWORD --body "<the same password>"

set -euo pipefail

: "${SMOKE_TEST_USERNAME:?SMOKE_TEST_USERNAME must be set}"
: "${SMOKE_TEST_PASSWORD:?SMOKE_TEST_PASSWORD must be set}"

# Password policy sanity check — match src/server/config/password-policy.ts.
# The DB accepts anything, but a smoke account that can't log in via the
# real password-policy-enforced flow on /api/auth/login is useless, so
# catch it here before we insert.
PASS_LEN=${#SMOKE_TEST_PASSWORD}
if [ "$PASS_LEN" -lt 12 ]; then
  echo "FAIL: SMOKE_TEST_PASSWORD must be at least 12 characters (got $PASS_LEN)" >&2
  exit 1
fi

# Hash the password using the app container's bcryptjs at the same version
# production uses. Running it inside the container avoids any
# host-vs-container version drift — whatever bcrypt round-trips there is
# what /api/auth/login will verify against.
echo "Hashing password via app container..."
HASH=$(docker compose -f /opt/projekt-manager/docker-compose.yml exec -T \
  -e PASSWORD="$SMOKE_TEST_PASSWORD" \
  app node --input-type=module -e "
    import bcrypt from 'bcryptjs';
    const h = await bcrypt.hash(process.env.PASSWORD, 10);
    process.stdout.write(h);
  ")

if [ -z "$HASH" ] || [ "${#HASH}" -lt 50 ]; then
  echo "FAIL: bcrypt hash looked wrong (length ${#HASH})" >&2
  exit 1
fi

# Load POSTGRES_PASSWORD for psql from the live .env
# shellcheck disable=SC1091
source <(grep -E '^POSTGRES_PASSWORD=' /opt/projekt-manager/.env)
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in /opt/projekt-manager/.env}"

# Insert the user. Uses psql -v to pass values as parameters so the
# shell-supplied strings never touch the SQL parser directly. ON CONFLICT
# on the username unique index makes this a no-op on re-run.
docker compose -f /opt/projekt-manager/docker-compose.yml exec -T \
  -e PGPASSWORD="$POSTGRES_PASSWORD" \
  db psql -U pm -d projekt_manager \
  -v ON_ERROR_STOP=1 \
  -v username="$SMOKE_TEST_USERNAME" \
  -v hash="$HASH" <<'SQL'
INSERT INTO users (username, display_name, password_hash, roles, active)
VALUES (:'username', 'Smoke Test (CI)', :'hash', ARRAY['bookkeeper'], true)
ON CONFLICT (username) DO NOTHING;
SELECT username, display_name, roles, active FROM users WHERE username = :'username';
SQL

echo ""
echo "--- Smoke test user ready: $SMOKE_TEST_USERNAME ---"
echo ""
echo "Next step: add the credentials to GitHub secrets:"
echo "  gh secret set SMOKE_TEST_USERNAME --body '$SMOKE_TEST_USERNAME'"
echo "  gh secret set SMOKE_TEST_PASSWORD --body '<paste the password>'"
