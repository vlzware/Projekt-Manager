#!/usr/bin/env bash
# Lint step: cross-reference ACs across spec, traceability matrix, and test files.
# Run from repo root: ./scripts/check-traceability.sh
# Exit 0 = clean, exit 1 = gaps found.

set -euo pipefail

SPEC="docs/spec/verification.md"
MATRIX="docs/testing/traceability.md"
TEST_DIRS="src e2e"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

errors=0
warnings=0

# --- 1. Extract ACs defined in the spec ---
spec_acs=$(grep -oP 'AC-\d+' "$SPEC" | sort -t- -k2 -n | uniq)
spec_count=$(echo "$spec_acs" | wc -l)

# --- 2. Extract ACs listed in the traceability matrix ---
matrix_acs=$(grep -oP '^\| AC-\d+' "$MATRIX" | grep -oP 'AC-\d+' | sort -t- -k2 -n | uniq)
matrix_count=$(echo "$matrix_acs" | wc -l)

# --- 3. Extract ACs referenced in test files ---
test_acs=$(grep -rhoP 'AC-\d+' $TEST_DIRS --include='*.test.*' --include='*.spec.ts' | sort -t- -k2 -n | uniq)

# --- 4. Extract tier from matrix ---
declare -A matrix_tier
while IFS='|' read -r _ ac tier _rest; do
  ac=$(echo "$ac" | xargs)
  tier=$(echo "$tier" | xargs)
  if [[ "$ac" =~ ^AC-[0-9]+$ ]]; then
    matrix_tier["$ac"]="$tier"
  fi
done < "$MATRIX"

# --- Check: ACs in spec but missing from matrix ---
echo -e "\n${GREEN}=== Traceability lint ===${NC}"
echo "Spec ACs: $spec_count | Matrix ACs: $matrix_count"
echo ""

missing_from_matrix=()
for ac in $spec_acs; do
  if ! echo "$matrix_acs" | grep -qx "$ac"; then
    missing_from_matrix+=("$ac")
  fi
done

if [ ${#missing_from_matrix[@]} -gt 0 ]; then
  echo -e "${RED}ERROR: ACs in spec but missing from traceability matrix:${NC}"
  for ac in "${missing_from_matrix[@]}"; do
    echo "  - $ac"
  done
  errors=$((errors + ${#missing_from_matrix[@]}))
else
  echo -e "${GREEN}✓ All spec ACs present in traceability matrix${NC}"
fi

# --- Check: ACs in matrix but not in spec (stale rows) ---
stale_in_matrix=()
for ac in $matrix_acs; do
  if ! echo "$spec_acs" | grep -qx "$ac"; then
    stale_in_matrix+=("$ac")
  fi
done

if [ ${#stale_in_matrix[@]} -gt 0 ]; then
  echo -e "${YELLOW}WARNING: ACs in matrix but not in spec (stale?):${NC}"
  for ac in "${stale_in_matrix[@]}"; do
    echo "  - $ac"
  done
  warnings=$((warnings + ${#stale_in_matrix[@]}))
else
  echo -e "${GREEN}✓ No stale ACs in traceability matrix${NC}"
fi

# --- Check: [crit] ACs must have UT or AT columns filled ---
crit_no_test=()
while IFS='|' read -r _ ac tier _ _ ut at e2e _notes; do
  ac=$(echo "$ac" | xargs)
  tier=$(echo "$tier" | xargs)
  ut=$(echo "$ut" | xargs)
  at=$(echo "$at" | xargs)
  if [[ "$tier" == "[crit]" && -z "$ut" && -z "$at" ]]; then
    # Check if it has at least E2E coverage
    e2e=$(echo "$e2e" | xargs)
    if [ -z "$e2e" ]; then
      crit_no_test+=("$ac (no UT, AT, or E2E)")
    else
      crit_no_test+=("$ac (E2E only — needs UT or AT)")
    fi
  fi
done < "$MATRIX"

if [ ${#crit_no_test[@]} -gt 0 ]; then
  echo -e "${YELLOW}WARNING: [crit] ACs without unit/integration test reference:${NC}"
  for item in "${crit_no_test[@]}"; do
    echo "  - $item"
  done
  warnings=$((warnings + ${#crit_no_test[@]}))
else
  echo -e "${GREEN}✓ All [crit] ACs have UT or AT references${NC}"
fi

# --- Check: [crit] ACs referenced in at least one test file ---
crit_not_in_code=()
for ac in $spec_acs; do
  tier="${matrix_tier[$ac]:-}"
  if [[ "$tier" == "[crit]" ]]; then
    if ! echo "$test_acs" | grep -qx "$ac"; then
      crit_not_in_code+=("$ac")
    fi
  fi
done

if [ ${#crit_not_in_code[@]} -gt 0 ]; then
  echo -e "${YELLOW}WARNING: [crit] ACs not referenced in any test file comment:${NC}"
  for ac in "${crit_not_in_code[@]}"; do
    echo "  - $ac"
  done
  warnings=$((warnings + ${#crit_not_in_code[@]}))
else
  echo -e "${GREEN}✓ All [crit] ACs referenced in test code${NC}"
fi

# --- Summary ---
echo ""
echo "---"
if [ $errors -gt 0 ]; then
  echo -e "${RED}$errors error(s), $warnings warning(s) — traceability check FAILED${NC}"
  exit 1
elif [ $warnings -gt 0 ]; then
  echo -e "${YELLOW}0 errors, $warnings warning(s) — traceability check PASSED with warnings${NC}"
  exit 0
else
  echo -e "${GREEN}0 errors, 0 warnings — traceability check clean${NC}"
  exit 0
fi
