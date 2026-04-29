#!/usr/bin/env bash
#
# Backup container entrypoint (Dockerfile.backup).
#
# Responsibilities:
#   1. Fail fast if the container is missing required env vars — a crond
#      that runs against undefined credentials would emit an hour of
#      AccessDenied noise before the operator notices.
#   2. Exec dcron in the foreground as PID 1 (no fork, no init-detach).
#
# Secrets are never echoed. Presence is asserted by "is it non-empty?",
# the value itself never hits stdout/stderr.
set -euo pipefail

required=(
  DATABASE_URL
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_ENDPOINT
  R2_BUCKET
  AGE_RECIPIENT
)

missing=()
for var in "${required[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "ERROR: backup container missing required env: ${missing[*]}" >&2
  echo "       set via secrets.env.age on the VPS (docs/ops/backup/setup.md §3)." >&2
  exit 1
fi

# AGE_RECIPIENT must be a public recipient (age1...), NOT the private
# identity. A common operator mistake ($recipient = AGE-SECRET-KEY-1...)
# would silently ship an unreadable-by-us encrypted blob to R2 that only
# the pasted private key can decrypt — catastrophic for drill + DR.
if [[ "${AGE_RECIPIENT}" != age1* ]]; then
  echo "ERROR: AGE_RECIPIENT does not look like a public recipient (expected age1... prefix)." >&2
  echo "       Re-derive from the private identity with: age-keygen -y <identity-file>" >&2
  exit 1
fi

echo "backup container: env OK"

# Authenticated R2 reachability probe. Fails fast on stale creds (the
# scenario a credential roll produces if only one of AKID/Secret was
# captured) or a dead endpoint, rather than letting crond start and
# emit SignatureDoesNotMatch at the next scheduled tick. See probe-r2.mjs
# for rationale and symmetry with the app's MinIO HeadBucket gate.
node /usr/local/bin/probe-r2.mjs

echo "backup container: R2 reachable, starting crond"

# dcron:
#   -f  foreground (become PID 1 — no daemonise, no re-exec).
#
# No -l override: dcron's `-l N` filters to events at level <= N (lower
# = more critical, syslog convention). Default is 5 (NOTICE), which
# captures scheduled-wakeup lines. A previous `-l 2` actually SUPPRESSED
# wakeups (kept only CRIT/ALERT/EMERG); the comment claiming "info-level"
# was inverted.
exec crond -f
