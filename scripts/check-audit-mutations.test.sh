#!/usr/bin/env bash
#
# Scenario tests for scripts/check-audit-mutations.sh (AC-179).
#
# The production check-audit-mutations.sh is hardcoded to scan the repo
# path `src/server`. For these tests we temporarily stage a fixture
# source tree inside a fresh git-clean temp directory, copy the script
# in, and run it there — each scenario asserts the expected exit code.
#
# Scenarios:
#   1. Allowlisted path — `src/server/services/mutate.ts` contains a
#      raw mutation. Expected: exit 0 (the path is in ALLOWLIST).
#   2. Non-allowlisted path — `src/server/repositories/customer.ts`
#      contains a raw mutation. Expected: exit 1.
#   3. Run against the current repo — many raw mutations outside
#      mutate(). Expected: exit 1 (confirms the failing state the
#      workflow's step 3 wants — mutate() does not exist yet).
#
# Usage:
#   bash scripts/check-audit-mutations.test.sh
#
# Exits 0 when every scenario passes; exits 1 on the first mismatch.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK_SCRIPT="$SCRIPT_DIR/check-audit-mutations.sh"

if [ ! -x "$CHECK_SCRIPT" ]; then
  echo "ERROR: $CHECK_SCRIPT not executable. chmod +x and try again." >&2
  exit 2
fi

pass=0
fail=0
failures=()

# -------------------------------------------------------------
# assert_exit <expected> <label> <cmd> [args...]
# -------------------------------------------------------------
assert_exit() {
  local expected="$1"
  local label="$2"
  shift 2
  local actual
  "$@" >/dev/null 2>&1
  actual=$?
  if [ "$actual" = "$expected" ]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
  fi
}

# -------------------------------------------------------------
# Scenario 1 — allowlisted path, raw mutation, expect pass.
# -------------------------------------------------------------
echo "Scenario 1: allowlisted path with raw mutation → expect exit 0"
tmp1="$(mktemp -d)"
trap 'rm -rf "$tmp1"' EXIT
mkdir -p "$tmp1/src/server/services" "$tmp1/scripts"
# Copy the check script (it runs `cd "$(dirname "$0")/.."` so place
# it in tmp1/scripts/).
cp "$CHECK_SCRIPT" "$tmp1/scripts/check-audit-mutations.sh"
chmod +x "$tmp1/scripts/check-audit-mutations.sh"
# A file in the allowlist authors a raw mutation.
cat > "$tmp1/src/server/services/mutate.ts" <<'EOF'
import { db, projects } from '../db.js';
export async function doWrite() {
  await db.insert(projects).values({ title: 'x' });
}
EOF
assert_exit 0 "allowlisted file authors raw mutation" bash "$tmp1/scripts/check-audit-mutations.sh"

# -------------------------------------------------------------
# Scenario 2 — non-allowlisted path, raw mutation, expect fail.
# -------------------------------------------------------------
echo ""
echo "Scenario 2: non-allowlisted path with raw mutation → expect exit 1"
tmp2="$(mktemp -d)"
trap 'rm -rf "$tmp1" "$tmp2"' EXIT
mkdir -p "$tmp2/src/server/repositories" "$tmp2/scripts"
cp "$CHECK_SCRIPT" "$tmp2/scripts/check-audit-mutations.sh"
chmod +x "$tmp2/scripts/check-audit-mutations.sh"
cat > "$tmp2/src/server/repositories/customer.ts" <<'EOF'
import { db, customers } from '../db.js';
export async function updateCustomer(id: string) {
  return db.update(customers).set({ name: 'new' }).where(eq(customers.id, id));
}
EOF
assert_exit 1 "non-allowlisted file authors raw mutation" bash "$tmp2/scripts/check-audit-mutations.sh"

# -------------------------------------------------------------
# Scenario 3 — current repo (pre-implementation), expect fail.
# -------------------------------------------------------------
# This scenario is the "positive-failure" case called out in step 3
# of the workflow: mutate() does not exist yet, so the check must
# find raw mutations across repositories.
#
# When implementation lands and every audited mutation is routed
# through mutate(), this assertion flips to expect 0 — the reviewer
# updates the expected value in the same PR that removes the
# raw-mutation sites.
echo ""
echo "Scenario 3: current repo (pre-implementation) → expect exit 1"
assert_exit 1 "current repo fails because mutate() does not exist" bash "$CHECK_SCRIPT"

echo ""
echo "-------------------------------------------------------------"
echo "  Passed: $pass"
echo "  Failed: $fail"
if [ "$fail" -gt 0 ]; then
  for f in "${failures[@]}"; do
    echo "    - $f"
  done
  exit 1
fi
echo "All scenarios passed."
exit 0
