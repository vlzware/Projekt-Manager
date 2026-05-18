#!/usr/bin/env bash
#
# Scenario tests for scripts/check-allowlist-schema.sh.
#
# Each case stages an osv-scanner.toml + .trivyignore pair in a fresh
# temp dir and runs the real check against it via $ALLOWLIST_REPO_ROOT.
# Exits 0 when every case matches its expected exit code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-allowlist-schema.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-allowlist-schema.sh"

if [[ ! -x "$CHECK_SCRIPT" ]]; then
  echo "ERROR: $CHECK_SCRIPT not executable. chmod +x and try again." >&2
  exit 2
fi

# Anchor dates to "today" so the suite stays green as the wall clock
# advances. The accepted window is [today, today+90d] (closed-closed
# per the script docstring); today-1 expires, today+91 is too-far.
TODAY="$(date -u +%F)"
PLUS_30="$(date -u -d "$TODAY +30 days" +%F)"
PLUS_90="$(date -u -d "$TODAY +90 days" +%F)"
PLUS_91="$(date -u -d "$TODAY +91 days" +%F)"
PLUS_100="$(date -u -d "$TODAY +100 days" +%F)"
YESTERDAY="$(date -u -d "$TODAY -1 day" +%F)"

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

mktmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  # Empty defaults so a case can stage just the file it cares about
  # without the other file's contents changing the outcome.
  : > "$d/osv-scanner.toml"
  : > "$d/.trivyignore"
  echo "$d"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  ALLOWLIST_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" >/dev/null 2>&1
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
  fi
}

# -------------------------------------------------------------
# OK: empty files (current repo baseline) → exit 0
# -------------------------------------------------------------
dir="$(mktmp)"
assert_case 0 "OK: empty osv-scanner.toml + empty .trivyignore" "$dir"

# -------------------------------------------------------------
# FAIL-osv-missing-reason
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
EOF
assert_case 1 "FAIL-osv-missing-reason" "$dir"

# -------------------------------------------------------------
# FAIL-osv-no-owner-prefix
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "dead code path"
EOF
assert_case 1 "FAIL-osv-no-owner-prefix" "$dir"

# -------------------------------------------------------------
# FAIL-osv-string-date — quoted date deserializes as str, not date
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = "$PLUS_30"
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-string-date" "$dir"

# -------------------------------------------------------------
# FAIL-osv-expired — yesterday
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $YESTERDAY
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-expired" "$dir"

# -------------------------------------------------------------
# FAIL-osv-too-far — 100 days
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_100
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-too-far" "$dir"

# -------------------------------------------------------------
# OK-osv-real-entry — fully valid
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@vlzware: dead code path — function bundled but never reached at runtime"
EOF
assert_case 0 "OK-osv-real-entry" "$dir"

# -------------------------------------------------------------
# FAIL-trivy-no-comment-block — bare entry, no preceding comments
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/.trivyignore" <<EOF
CVE-2026-12345 exp:$PLUS_30
EOF
assert_case 1 "FAIL-trivy-no-comment-block" "$dir"

# -------------------------------------------------------------
# FAIL-trivy-missing-owner — has `# reason:` but no `# owner:`
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/.trivyignore" <<EOF
# reason: only inbound TCP 9000 is affected; our image binds 8080
CVE-2026-12345 exp:$PLUS_30
EOF
assert_case 1 "FAIL-trivy-missing-owner" "$dir"

# -------------------------------------------------------------
# FAIL-trivy-no-exp — block complete, entry has no exp:
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/.trivyignore" <<EOF
# owner: @vlzware
# reason: only inbound TCP 9000 is affected; our image binds 8080
CVE-2026-12345
EOF
assert_case 1 "FAIL-trivy-no-exp" "$dir"

# -------------------------------------------------------------
# OK-trivy-real-entry — full valid entry
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/.trivyignore" <<EOF
# owner: @vlzware
# reason: only inbound TCP 9000 is affected; our image binds 8080
CVE-2026-12345 exp:$PLUS_30
EOF
assert_case 0 "OK-trivy-real-entry" "$dir"

# -------------------------------------------------------------
# Boundary cases — exact window edges
# -------------------------------------------------------------

# OK-osv-boundary-today — ignoreUntil = today is the inclusive lower edge.
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $TODAY
reason = "@vlzware: dead code"
EOF
assert_case 0 "OK-osv-boundary-today" "$dir"

# OK-osv-boundary-plus-90 — exact inclusive upper edge.
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_90
reason = "@vlzware: dead code"
EOF
assert_case 0 "OK-osv-boundary-plus-90" "$dir"

# FAIL-osv-boundary-plus-91 — first day past the window.
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_91
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-boundary-plus-91" "$dir"

# -------------------------------------------------------------
# TOML datetime — caused an uncaught TypeError pre-fix
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = ${PLUS_30}T00:00:00Z
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-datetime-not-date" "$dir"

# -------------------------------------------------------------
# id validation — empty string and non-string must be rejected
# -------------------------------------------------------------

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = ""
ignoreUntil = $PLUS_30
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-id-empty" "$dir"

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = 12345
ignoreUntil = $PLUS_30
reason = "@vlzware: dead code"
EOF
assert_case 1 "FAIL-osv-id-nonstring" "$dir"

# -------------------------------------------------------------
# GitHub handle validation — `@` with no body, hyphen edges, double
# hyphens, length over 39 must all be rejected.
# -------------------------------------------------------------

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@: dead code"
EOF
assert_case 1 "FAIL-osv-handle-empty" "$dir"

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@-: dead code"
EOF
assert_case 1 "FAIL-osv-handle-leading-hyphen" "$dir"

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@vlz-: dead code"
EOF
assert_case 1 "FAIL-osv-handle-trailing-hyphen" "$dir"

dir="$(mktmp)"
cat > "$dir/osv-scanner.toml" <<EOF
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = $PLUS_30
reason = "@vl--ware: dead code"
EOF
assert_case 1 "FAIL-osv-handle-consecutive-hyphens" "$dir"

# -------------------------------------------------------------
# Trivy ID acceptance — script no longer enforces the ID's shape;
# hyphenless KSV*, AVD-style with extra hyphens, and lowercase secret
# rule IDs (`aws-access-token`) must all pass IF metadata is correct.
# -------------------------------------------------------------

dir="$(mktmp)"
cat > "$dir/.trivyignore" <<EOF
# owner: @vlzware
# reason: container scan finds KSV001 in IaC; manifest is dev-only
KSV001 exp:$PLUS_30
EOF
assert_case 0 "OK-trivy-hyphenless-id" "$dir"

dir="$(mktmp)"
cat > "$dir/.trivyignore" <<EOF
# owner: @vlzware
# reason: secret scan rule on dev fixture key
aws-access-token exp:$PLUS_30
EOF
assert_case 0 "OK-trivy-lowercase-id" "$dir"

# -------------------------------------------------------------
# Trivy owner-comment validation — `@` with no body, leading hyphen
# -------------------------------------------------------------
dir="$(mktmp)"
cat > "$dir/.trivyignore" <<EOF
# owner: @
# reason: bare @, no handle
CVE-2026-12345 exp:$PLUS_30
EOF
assert_case 1 "FAIL-trivy-owner-empty" "$dir"

dir="$(mktmp)"
cat > "$dir/.trivyignore" <<EOF
# owner: @-vlzware
# reason: leading hyphen is not a valid GitHub handle
CVE-2026-12345 exp:$PLUS_30
EOF
assert_case 1 "FAIL-trivy-owner-leading-hyphen" "$dir"

echo ""
echo "-------------------------------------------------------------"
echo "  Passed: $pass"
echo "  Failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  for f in "${failures[@]}"; do
    echo "    - $f"
  done
  exit 1
fi
echo "All cases passed."
exit 0
