#!/usr/bin/env bash
#
# Cron-triggered Tier 2 drill entry (verify-on-cycle — see ADR-0020
# §Decision and docs/spec/architecture.md §11.10).
#
# Reads the operator-loaded age identity from a tmpfs path. When the
# identity file is absent or empty, the TypeScript drill service quick-
# exits with outcome='skipped' per AC-168 (skip != failure).
#
# Exit codes mirror run-backup.sh: 0 success/skipped, 1 env missing,
# 2 lock held, 3+ runner failure.
set -euo pipefail

LOCKFILE="/var/run/drill.lock"

# Default identity path must match the tmpfs mountpoint in the compose
# service and the destination load-drill-key.sh writes to. Keep the
# default in ONE place: override via env if the three ever need to
# diverge.
AGE_IDENTITY_PATH="${AGE_IDENTITY_PATH:-/run/drill-key/identity}"

# TODO(phase-3-sync, backend stream): confirm entry path — pair with
# run-backup.sh. Expected:
#   node /app/dist/server/backup-runner.js drill
RUNNER_BIN="${BACKUP_RUNNER_BIN:-node}"
RUNNER_SCRIPT="${BACKUP_RUNNER_SCRIPT:-/app/dist/server/backup-runner.js}"

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
  [[ -z "${!var:-}" ]] && missing+=("$var")
done
if (( ${#missing[@]} > 0 )); then
  echo "run-drill: missing env: ${missing[*]}" >&2
  exit 1
fi

# Separate lockfile from run-backup.sh — a drill does not block a
# backup (they operate on independent R2 keys and independent ephemeral
# Postgres instances per ADR-0020). Two parallel drills ARE prevented.
exec 201>"$LOCKFILE"
if ! flock -n 201; then
  echo "run-drill: another drill is in flight; skipping this tick" >&2
  exit 2
fi

if [[ ! -f "$RUNNER_SCRIPT" ]]; then
  echo "run-drill: runner script not found at $RUNNER_SCRIPT" >&2
  exit 3
fi

export AGE_IDENTITY_PATH
"$RUNNER_BIN" "$RUNNER_SCRIPT" drill
