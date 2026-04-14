#!/usr/bin/env bash
#
# Lint step: enforce the design-token single-source rule from AC-108.
#
# AC-108 [infra]: Palette and semantic color tokens are defined in a single
# source consumed by all components. No component or stylesheet references
# a palette color outside that source. State colors, applied from the state
# configuration array, are the single documented exception.
#
# This script scans src/**/*.{css,module.css,ts,tsx} for hex color literals
# (#RGB, #RGBA, #RRGGBB, #RRGGBBAA) and fails if any are found outside the
# allowlist. Palette leaks outside the token source defeat theming — a dark
# mode override has no effect on a hardcoded #fff in a stylesheet.
#
# Allowlist:
#   src/styles/tokens.css     — the single source of palette + semantic tokens
#   src/config/stateConfig.ts — data-driven state colors (documented exception)
#
# The script is intentionally strict: any new file that needs raw hex values
# must be justified and added here, not silently added to src/.
#
# Run from repo root: ./scripts/check-theme-tokens.sh
# Exit 0 = clean, exit 1 = leaks found.

set -euo pipefail

cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Files allowed to contain palette hex literals. Each entry is a repo-relative
# path. The script still detects hex in these files; it just does not fail on
# matches from them.
ALLOWLIST=(
  "src/styles/tokens.css"
  "src/config/stateConfig.ts"
)

# --- Hex literal pattern --------------------------------------------------
# Match #RGB, #RGBA, #RRGGBB, or #RRGGBBAA bounded by a word boundary. The
# ripgrep regex uses a negative lookbehind implicitly through the leading
# context filter below — we do not try to parse CSS; we apply a cheap set of
# post-filters against obvious false positives (URL hash fragments, shebangs,
# inline // comments).
HEX_PATTERN='#[0-9a-fA-F]{3,8}\b'

# Build the ripgrep exclusion for allowlisted files. ripgrep --glob with a
# leading `!` excludes.
rg_args=(
  --line-number
  --no-heading
  --color=never
  --sort=path
  --type-add 'cssmod:*.module.css'
  --glob 'src/**/*.css'
  --glob 'src/**/*.ts'
  --glob 'src/**/*.tsx'
)
for entry in "${ALLOWLIST[@]}"; do
  rg_args+=(--glob "!${entry}")
done

# Run ripgrep. Disable pipefail for this one call because rg exits 1 on "no
# matches" which is actually the success case for us.
set +o pipefail
raw_matches=$(rg "${HEX_PATTERN}" "${rg_args[@]}" || true)
set -o pipefail

# --- Filter out obvious false positives -----------------------------------
# Drop lines that are a pure `//` comment. No URL-fragment filter: a cleverer
# heuristic can drop whole lines (and hide real leaks alongside a URL). CSS
# `url(...#fragment)` on a palette-bearing line is rare enough that false
# positives are acceptable — refactor the URL to a constant or split the
# line if one ever appears.
filtered=$(printf '%s\n' "$raw_matches" \
  | awk -F: '
    NF < 3 { next }
    {
      file = $1
      line = $2
      content = $0
      sub(/^[^:]*:[^:]*:/, "", content)
      if (match(content, /^[[:space:]]*\/\//)) next
      print file ":" line ":" content
    }
  ')

# --- Report ---------------------------------------------------------------
echo -e "${GREEN}=== Theme token hygiene check ===${NC}"
echo "Scope: src/**/*.{css,module.css,ts,tsx}"
echo "Allowlist:"
for entry in "${ALLOWLIST[@]}"; do
  echo "  - ${entry}"
done
echo ""

if [ -z "$filtered" ]; then
  echo -e "${GREEN}✓ no palette leaks outside the tokens source${NC}"
  exit 0
fi

# Count matches and files.
leak_count=$(printf '%s\n' "$filtered" | grep -c . || true)
leak_files=$(printf '%s\n' "$filtered" | cut -d: -f1 | sort -u | wc -l)

echo -e "${RED}✗ Palette hex leaks detected outside the token source:${NC}"
echo ""
printf '%s\n' "$filtered" | awk -F: '
  {
    file = $1
    line = $2
    content = $0
    sub(/^[^:]*:[^:]*:/, "", content)
    # Trim leading whitespace from content for display.
    sub(/^[[:space:]]+/, "", content)
    printf "  %s:%s  %s\n", file, line, content
  }
'

echo ""
echo -e "${YELLOW}Summary: ${leak_count} leak(s) across ${leak_files} file(s).${NC}"
echo ""
echo "AC-108 requires palette colors to live only in:"
for entry in "${ALLOWLIST[@]}"; do
  echo "  - ${entry}"
done
echo ""
echo "Fix: replace the hex literal with a semantic token reference"
echo "     (e.g. var(--color-surface-base)) defined in src/styles/tokens.css."
echo -e "${RED}Theme token hygiene check FAILED${NC}"
exit 1
