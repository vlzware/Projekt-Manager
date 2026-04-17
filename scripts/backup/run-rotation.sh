#!/usr/bin/env bash
#
# GFS rotation for Layer 2 backups (see ADR-0020 §Decision and
# docs/spec/architecture.md §11.10).
#
# Retention: 7 daily, 4 weekly, 12 monthly.
#
# Promotion rules:
#   - Sunday UTC:       copy the newest daily/ into weekly/.
#   - 1st of month UTC: copy the newest daily/ into monthly/.
#
# Cleanup rules (count-based, not calendar-based — deterministic and
# doesn't drift across timezones or missed runs):
#   - daily/:   keep newest 7, delete the rest.
#   - weekly/:  keep newest 4, delete the rest.
#   - monthly/: keep newest 12, delete the rest.
#
# R2 bucket-lock + 30-day lifecycle do their own work at the provider
# level (ADR-0020 §Decision). This script cooperates rather than
# fights it: deletes against objects still inside the 14-day lock
# window will NO-OP at the provider — that is expected and harmless.
# The lifecycle rule sweeps leftovers on day 30.
#
# Exit codes: 0 success, 1 env missing, 2 lock held.
set -euo pipefail

LOCKFILE="/var/run/rotation.lock"

DAILY_KEEP="${DAILY_KEEP:-7}"
WEEKLY_KEEP="${WEEKLY_KEEP:-4}"
MONTHLY_KEEP="${MONTHLY_KEEP:-12}"

required=(
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_ENDPOINT
  R2_BUCKET
)
missing=()
for var in "${required[@]}"; do
  [[ -z "${!var:-}" ]] && missing+=("$var")
done
if (( ${#missing[@]} > 0 )); then
  echo "run-rotation: missing env: ${missing[*]}" >&2
  exit 1
fi

exec 202>"$LOCKFILE"
if ! flock -n 202; then
  echo "run-rotation: another rotation is in flight; skipping this tick" >&2
  exit 2
fi

# Export for aws-cli without the R2_ prefix.
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${R2_REGION:-auto}"

# aws_ls <prefix>
#   Emit one object key per line, NEWEST FIRST.
#   `aws s3 ls` output: "YYYY-MM-DD HH:MM:SS  SIZE  KEY".
#   Sort by the ISO timestamp in the key itself (column 4). Timestamps
#   in our keys are ISO-8601 with a `-` separator for time (see
#   ADR-0020 §Decision + recovery.md §8 example: 2026-04-17T02-00-12Z).
#   ISO-8601 sorts lexically in chronological order, so `sort -r` on
#   the KEY column gives newest-first without parsing the date cell.
aws_ls() {
  local prefix="$1"
  aws s3 ls "s3://${R2_BUCKET}/${prefix}" \
    --endpoint-url "$R2_ENDPOINT" \
    2>/dev/null \
    | awk 'NF>=4 {print $4}' \
    | sort -r
}

aws_cp() {
  local src="$1" dst="$2"
  aws s3 cp "s3://${R2_BUCKET}/${src}" "s3://${R2_BUCKET}/${dst}" \
    --endpoint-url "$R2_ENDPOINT" \
    --only-show-errors
}

aws_rm() {
  local key="$1"
  aws s3 rm "s3://${R2_BUCKET}/${key}" \
    --endpoint-url "$R2_ENDPOINT" \
    --only-show-errors
}

# is_object_lock_error <aws-cli-error-text>
#   Return 0 when the captured error indicates the object is still
#   inside its object-lock retention window, 1 otherwise. Treated as
#   "expected, log and continue" by the cleanup loop.
#
#   R2's bucket-lock response body wraps the S3 Object Lock codes, so
#   we match on the canonical S3 strings plus the R2-specific phrasing.
#   A plain 403/AccessDenied is intentionally NOT a match — a genuine
#   credential problem has the same HTTP code as a retention block but
#   must fail loudly, not be swallowed.
is_object_lock_error() {
  local raw="$1"
  if echo "$raw" | grep -qE 'ObjectLockRetained|ObjectLockRetainDate|retention period has not expired'; then
    return 0
  fi
  # 403 + an explicit mention of "retention" in the same response
  # counts as lock-denial. Anything else (plain AccessDenied with no
  # retention cue) falls through to the loud-fail branch.
  if echo "$raw" | grep -q '403' && echo "$raw" | grep -qi 'retention'; then
    return 0
  fi
  return 1
}

# --- Promotions ------------------------------------------------------
# Read today's UTC day-of-week and day-of-month once. date -u so the
# schedule is independent of any TZ surprises from the base image.
dow="$(date -u +%u)"   # 1..7, Mon..Sun
dom="$(date -u +%d)"   # 01..31

newest_daily="$(aws_ls 'daily/' | head -n 1 || true)"

if [[ -n "$newest_daily" ]]; then
  # Strip the 'daily/' prefix to get the bare filename for re-keying.
  basename="${newest_daily#daily/}"

  if [[ "$dow" == "7" ]]; then
    echo "run-rotation: Sunday — promoting $newest_daily to weekly/"
    aws_cp "$newest_daily" "weekly/${basename}" || echo "run-rotation: weekly promotion failed (continuing)" >&2
  fi

  if [[ "$dom" == "01" ]]; then
    echo "run-rotation: 1st of month — promoting $newest_daily to monthly/"
    aws_cp "$newest_daily" "monthly/${basename}" || echo "run-rotation: monthly promotion failed (continuing)" >&2
  fi
else
  echo "run-rotation: no daily backups present — skipping promotions" >&2
fi

# --- Cleanup ---------------------------------------------------------
# For each prefix, list newest-first and delete everything past the
# keep threshold. `tail -n +N` drops the first N-1 lines.
cleanup() {
  local prefix="$1" keep="$2"
  local drop_after=$((keep + 1))
  local keys
  keys="$(aws_ls "$prefix" | tail -n "+${drop_after}" || true)"

  if [[ -z "$keys" ]]; then
    echo "run-rotation: ${prefix} within retention (${keep}); no deletions"
    return 0
  fi

  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    echo "run-rotation: deleting $key (outside ${prefix} retention)"
    # Capture stderr separately so we can classify the failure. A lock
    # window denial is expected and logged; anything else (bad creds,
    # bucket gone, network blip) is a real failure — exit 1 so cron
    # reports a non-zero status and the operator sees it in the
    # container logs.
    local rm_err
    if ! rm_err="$(aws_rm "$key" 2>&1 1>/dev/null)"; then
      if is_object_lock_error "$rm_err"; then
        echo "run-rotation: delete skipped for $key (within object-lock window — OK)" >&2
      else
        echo "run-rotation: delete failed for $key (non-lock error; aborting)" >&2
        echo "run-rotation: aws-cli said: $rm_err" >&2
        return 1
      fi
    fi
  done <<< "$keys"
}

cleanup "daily/"   "$DAILY_KEEP"
cleanup "weekly/"  "$WEEKLY_KEEP"
cleanup "monthly/" "$MONTHLY_KEEP"

echo "run-rotation: done"
