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

# Password policy check + bcrypt hash, both done inside the app container.
#
# The policy lives in src/server/config/password-policy.ts and has three
# rules: MIN_PASSWORD_LENGTH = 8 characters, MAX_PASSWORD_BYTES = 72
# (bcrypt truncates at 72 bytes), and a common-password blocklist.
# An earlier revision of this script hard-coded a 12-character minimum
# in shell, which was stricter than the real policy on length and
# silently skipped the byte-length and blocklist rules. That meant a
# password like `'测'.repeat(25)` would pass this check (25 chars >= 12)
# and then get truncated at 72 bytes by bcrypt, and the policy
# blocklist rule was never applied at all.
#
# Mirror the first two rules exactly; the blocklist is a data module
# bundled into dist/server/start.js and not reachable from a standalone
# node invocation, so we skip it here and rely on the server-side
# enforcement at /api/auth/login. If the operator picks a blocklisted
# password, the next smoke E2E run will fail loudly with a login
# error — that's the right time to catch it, for a one-shot account.
echo "Checking password policy and hashing..."
HASH=$(docker compose -f /opt/projekt-manager/docker-compose.yml exec -T \
  -e PASSWORD="$SMOKE_TEST_PASSWORD" \
  app node --input-type=module -e "
    const p = process.env.PASSWORD;
    if (p.length < 8) {
      console.error('FAIL: password has ' + p.length + ' characters, min 8');
      process.exit(1);
    }
    const bytes = Buffer.byteLength(p, 'utf8');
    if (bytes > 72) {
      console.error('FAIL: password is ' + bytes + ' UTF-8 bytes, max 72 (bcrypt truncation point)');
      process.exit(1);
    }
    const bcryptModule = await import('bcryptjs');
    const bcrypt = bcryptModule.default ?? bcryptModule;
    const h = await bcrypt.hash(p, 10);
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
