#!/usr/bin/env bash
# Post-deploy smoke E2E test (#58).
#
# Runs ON the VPS itself (inside the WireGuard tunnel) and exercises the
# full HTTPS + Caddy + auth + API chain via curl --resolve. Non-destructive
# by construction: only mutates session state, and the logout step deletes
# the session it creates. No project/user/file writes.
#
# Called from .github/workflows/deploy.yml after the existing
# in-container health check (`docker compose exec ... /api/health`) passes.
# The existing check validates the app container's internal listener; this
# one validates that the traffic can actually flow all the way through
# Caddy, the TLS chain, and the auth middleware — the path that real users
# take.
#
# Runner location: the script runs on the VPS (not on a GitHub-hosted
# runner) because Caddy's :443 listener is bound only to the WireGuard
# interface, and GitHub-hosted runners cannot join the tunnel (#47).
# Running on the VPS itself gives us TLS + real cert validation without
# standing up self-hosted runner infrastructure.
#
# Required env vars:
#   SMOKE_TEST_USERNAME — long-lived smoke-test account username
#   SMOKE_TEST_PASSWORD — long-lived smoke-test account password
#
# DOMAIN and WG_BIND_IP come from /opt/projekt-manager/.env (the same
# file the compose stack reads).

set -euo pipefail

# ---------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------

# shellcheck disable=SC1091  # .env is generated at deploy time, not in VCS
source <(grep -E '^(DOMAIN|WG_BIND_IP)=' /opt/projekt-manager/.env)
: "${DOMAIN:?DOMAIN must be set in /opt/projekt-manager/.env}"
: "${WG_BIND_IP:?WG_BIND_IP must be set in /opt/projekt-manager/.env}"
: "${SMOKE_TEST_USERNAME:?SMOKE_TEST_USERNAME must be set in the environment}"
: "${SMOKE_TEST_PASSWORD:?SMOKE_TEST_PASSWORD must be set in the environment}"

BASE="https://${DOMAIN}"
# --resolve routes curl's DNS lookup for DOMAIN:443 to the WireGuard
# interface IP without touching /etc/hosts. The real Let's Encrypt cert
# and SNI still validate correctly because the TLS session still
# presents DOMAIN as the hostname.
RESOLVE="${DOMAIN}:443:${WG_BIND_IP}"

COOKIES=$(mktemp -t smoke-cookies.XXXXXX)
HEADERS=$(mktemp -t smoke-headers.XXXXXX)
cleanup() {
  # Session cookie is sensitive until the logout step runs; shred if
  # shred is available (coreutils), fall back to rm otherwise.
  shred -u "$COOKIES" "$HEADERS" 2>/dev/null || rm -f "$COOKIES" "$HEADERS"
}
trap cleanup EXIT

# Common curl arguments:
#   --fail         — exit non-zero on HTTP >=400, so `set -e` aborts
#   --silent       — no progress bar
#   --show-error   — still print error details on failure
#   --resolve      — route DOMAIN:443 to the WG interface
#   --max-time 10  — per-request ceiling so a hung connection can't
#                    block the whole deploy
#   --retry 0      — deliberately no retries: flakes should surface
CURL=(curl --fail --silent --show-error --resolve "$RESOLVE" --max-time 10 --retry 0)

step() {
  echo "--- $1 ---"
}

fail() {
  echo "FAIL: $1" >&2
  if [ -s "$HEADERS" ]; then
    echo "--- last response headers ---" >&2
    cat "$HEADERS" >&2
  fi
  exit 1
}

# ---------------------------------------------------------------------
# 1. GET /api/health — via Caddy, real TLS
# ---------------------------------------------------------------------
step "1. GET /api/health (via Caddy + TLS)"
HEALTH_BODY=$("${CURL[@]}" -D "$HEADERS" "$BASE/api/health")
echo "$HEALTH_BODY" | grep -q '"status":"ok"' \
  || fail "health body did not contain status:ok — got: $HEALTH_BODY"
echo "OK"

# ---------------------------------------------------------------------
# 2. POST /api/auth/login — returns Secure HttpOnly SameSite=Strict cookie
# ---------------------------------------------------------------------
step "2. POST /api/auth/login"
# Build the JSON body via `jq -n --arg` so any special character in the
# password (quote, backslash, dollar sign, backtick, newline) is escaped
# correctly. An earlier revision of this script used a bare here-doc —
# that was broken: a `"` in the password produced `{"password":"abc"def"}`
# (JSON parse error), a `$var` was expanded by bash (silently altered),
# and a `\` made an invalid JSON escape.
#
# jq is present on the deploy VPS (verified as part of #58) — if a future
# environment lacks it, install via `apt-get install -y jq` in the server
# bootstrap, not by falling back to heredoc.
LOGIN_PAYLOAD=$(jq -nc \
  --arg u "$SMOKE_TEST_USERNAME" \
  --arg p "$SMOKE_TEST_PASSWORD" \
  '{username:$u,password:$p}')
: > "$HEADERS"
"${CURL[@]}" \
  -c "$COOKIES" \
  -D "$HEADERS" \
  -X POST \
  -H 'Content-Type: application/json' \
  -d "$LOGIN_PAYLOAD" \
  "$BASE/api/auth/login" > /dev/null

SETCOOKIE=$(grep -i '^set-cookie:' "$HEADERS" || true)
[ -n "$SETCOOKIE" ] || fail "login response had no Set-Cookie header"
echo "$SETCOOKIE" | grep -qi 'HttpOnly'            || fail "session cookie missing HttpOnly"
echo "$SETCOOKIE" | grep -qi 'Secure'              || fail "session cookie missing Secure"
echo "$SETCOOKIE" | grep -qi 'SameSite=Strict'     || fail "session cookie missing SameSite=Strict"
echo "OK"

# ---------------------------------------------------------------------
# 3. GET /api/auth/me — authenticated
# ---------------------------------------------------------------------
step "3. GET /api/auth/me"
: > "$HEADERS"
ME_BODY=$("${CURL[@]}" -b "$COOKIES" -D "$HEADERS" "$BASE/api/auth/me")
echo "$ME_BODY" | grep -q "\"username\":\"${SMOKE_TEST_USERNAME}\"" \
  || fail "/api/auth/me did not return the smoke user — got: ${ME_BODY:0:200}"
echo "OK"

# ---------------------------------------------------------------------
# 4. GET /api/projects — shape check only, no row count assertions
# ---------------------------------------------------------------------
step "4. GET /api/projects"
: > "$HEADERS"
PROJECTS_BODY=$("${CURL[@]}" -b "$COOKIES" -D "$HEADERS" "$BASE/api/projects")
# The payload should include a "data" key whose value is an array.
# Do not assert on the row count — that would couple the smoke test to
# real production data and break every time the inbox changes.
echo "$PROJECTS_BODY" | grep -q '"data":\[' \
  || fail "/api/projects missing data array — got: ${PROJECTS_BODY:0:200}"
echo "OK"

# ---------------------------------------------------------------------
# 5. POST /api/auth/logout — deletes the session row
# ---------------------------------------------------------------------
step "5. POST /api/auth/logout"
: > "$HEADERS"
"${CURL[@]}" \
  -b "$COOKIES" \
  -c "$COOKIES" \
  -D "$HEADERS" \
  -X POST \
  "$BASE/api/auth/logout" > /dev/null
echo "OK"

echo ""
echo "--- Smoke E2E passed for ${DOMAIN} ---"
