#!/usr/bin/env bash
#
# Cron-triggered backup entry (Tier 1 verify-on-create — see ADR-0020
# §Decision and docs/spec/architecture.md §11.10).
#
# Shape:
#   1. Assert required env (secrets come from the compose env_file).
#   2. Hold a flock so a late-running backup cannot overlap the next
#      tick's run.
#   3. Invoke the TypeScript backup service. The service does the full
#      pg_dump + manifest + Tier 1 verify + encrypt + upload + dual-write
#      status pipeline (AC-165/166/167/169/174). This script is a thin
#      shell-side orchestrator — we deliberately do NOT reimplement the
#      pipeline in bash.
#
# Exit codes:
#   0  success
#   1  env missing
#   2  another run is in flight (flock already held) — expected on a
#      backup that exceeds its interval; next tick will retry.
#   3+ service failure (propagated from the runner). crond sees the
#      non-zero exit and logs it; the next interval will retry
#      naturally — no at-least-once machinery needed because the
#      artifact key is a fresh ISO timestamp per run.
set -euo pipefail

LOCKFILE="/var/run/backup.lock"
# Phase 3 sync: the backend stream (src/server/services/backup.ts)
# must publish a CLI entrypoint that this script invokes. Expected path
# inside the app image, exposed to the backup container via the shared
# image layer (see §TODO below):
#   node /app/dist/server/backup-runner.js run
# where `run` is the subcommand that maps to services/backup.ts::runBackup.
# If the backend picks a different path/command, change the RUNNER line
# here to match — this is the ONLY coupling point between the two streams.
#
# TODO(phase-3-sync, backend stream): confirm entry path
#   - file:     src/server/backup-runner.ts (bundled to dist/server/backup-runner.js)
#   - subcmd:   run    (pair with `drill` in run-drill.sh)
#   - the container needs a read-only bind of the app image's /app/dist
#     OR the backup image FROM the same base as the app image. Compose
#     wires this; if a different wiring is chosen, update this path.
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
  echo "run-backup: missing env: ${missing[*]}" >&2
  exit 1
fi

# flock -n 200: non-blocking — if the lock is held, exit 2 rather than
# queue up behind a stuck run. A stuck run is an operator problem;
# queueing would mask it. File descriptor 200 is an arbitrary
# high-numbered fd standard in flock examples, avoiding 0/1/2.
exec 200>"$LOCKFILE"
if ! flock -n 200; then
  echo "run-backup: another backup is in flight; skipping this tick" >&2
  exit 2
fi

if [[ ! -f "$RUNNER_SCRIPT" ]]; then
  echo "run-backup: runner script not found at $RUNNER_SCRIPT" >&2
  echo "            Phase-3 sync: backend stream must publish this entry" >&2
  exit 3
fi

# Stdout/stderr flow to the container's default logging driver (compose
# json-file). No explicit redirect — we want the backend service's
# structured log lines to show up verbatim in `docker compose logs backup`.
"$RUNNER_BIN" "$RUNNER_SCRIPT" run
