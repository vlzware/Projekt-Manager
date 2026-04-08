#!/usr/bin/env bash
#
# Static drift check between src/server/config/env.ts and docker-compose.yml.
#
# Every variable declared in the Zod schema in env.ts MUST be forwarded to
# the app container via `services.app.environment` in docker-compose.yml —
# otherwise the container starts fine, but `process.env.X` is undefined at
# runtime and the app silently falls back to whatever Zod considers the
# default. That class of bug bit us in #57 when BOOTSTRAP_ADMIN_* were
# added to the schema but the compose whitelist was not updated; on the
# first deploy the bootstrap hook took the AC-B4 "nothing set → no-op"
# path instead of firing, and the failure was silent.
#
# This check is grep/awk-based rather than a YAML parser so it has no
# dependencies beyond a standard POSIX toolchain (ubuntu-latest GitHub
# runners ship with mawk, not gawk, so portability matters). It is
# intentionally strict: new vars require explicit placement in the
# compose file or explicit entry in the EXCLUDE list below.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_TS="src/server/config/env.ts"
COMPOSE="docker-compose.yml"

if [ ! -f "$ENV_TS" ]; then
  echo "ERROR: $ENV_TS not found — run from project root or adjust script path." >&2
  exit 2
fi
if [ ! -f "$COMPOSE" ]; then
  echo "ERROR: $COMPOSE not found — run from project root or adjust script path." >&2
  exit 2
fi

# Vars the app code declares but intentionally DOES NOT consume at runtime.
# DOMAIN is used by Caddy (Caddyfile) and for display purposes; the app
# container has no code path that reads it. If this list grows, document
# the reason inline so future drift does not become "just add it to the
# exclude list" by reflex.
EXCLUDE_PATTERN='^(DOMAIN)$'

# --- Extract env var names from the Zod schema ----------------------------
# Matches lines like `  BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),` —
# 2-space indent, UPPER_SNAKE_CASE identifier, colon. Any Zod pattern works
# after the colon; we only care about the name.
schema_vars=$(grep -oE '^  [A-Z_][A-Z0-9_]+:' "$ENV_TS" | tr -d ' :' | sort -u)

if [ -z "$schema_vars" ]; then
  echo "ERROR: no env vars found in $ENV_TS — did the schema format change?" >&2
  exit 2
fi

# --- Extract env var names from services.app.environment ------------------
# State-machine awk: track whether we are inside the `app:` service's
# `environment:` block, emit only UPPER_SNAKE var names at 6-space indent.
compose_app_vars=$(awk '
  # A top-level service name: 2-space indent, identifier, colon, EOL.
  /^  [a-z][a-zA-Z0-9_-]*:[[:space:]]*$/ {
    svc = $0
    sub(/^  /, "", svc)
    sub(/:[[:space:]]*$/, "", svc)
    in_app = (svc == "app")
    in_env = 0
    next
  }
  # `environment:` key inside the current service (4-space indent).
  in_app && /^    environment:[[:space:]]*$/ { in_env = 1; next }
  # Any other 4-space property ends the environment block.
  in_app && in_env && /^    [a-zA-Z]/ { in_env = 0 }
  # Env var entry at 6-space indent inside the environment block.
  in_app && in_env && /^      [A-Z_][A-Z0-9_]+:/ {
    name = $1
    sub(/:.*$/, "", name)
    print name
  }
' "$COMPOSE" | sort -u)

if [ -z "$compose_app_vars" ]; then
  echo "ERROR: no env vars found in $COMPOSE services.app.environment — did the compose format change?" >&2
  exit 2
fi

# --- Diff and report ------------------------------------------------------
# Vars in the schema minus exclusions.
schema_to_check=$(echo "$schema_vars" | grep -vE "$EXCLUDE_PATTERN" || true)

missing=$(comm -23 <(echo "$schema_to_check") <(echo "$compose_app_vars") || true)

if [ -n "$missing" ]; then
  echo "ERROR: env.ts declares vars that are NOT in docker-compose.yml services.app.environment:" >&2
  echo "$missing" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Add the missing vars to services.app.environment in docker-compose.yml." >&2
  echo "Without that, the container cannot see them at runtime and the Zod" >&2
  echo "schema silently falls back to defaults (or the code sees undefined)." >&2
  echo "" >&2
  echo "If a variable is intentionally not consumed by the app container" >&2
  echo "(e.g. consumed by Caddy or another service), add it to the" >&2
  echo "EXCLUDE_PATTERN in $(basename "$0") with an inline reason." >&2
  exit 1
fi

echo "OK: $ENV_TS ↔ $COMPOSE services.app.environment in sync"
echo "  schema vars checked: $(echo "$schema_to_check" | wc -l)"
echo "  excluded: $(echo "$schema_vars" | grep -cE "$EXCLUDE_PATTERN" || echo 0)"
