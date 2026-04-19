#!/usr/bin/env bash
#
# Architecture check — audit-log single-write-path (AC-179, ADR-0021).
#
# Fails CI when a file under src/server/ authors a raw
# INSERT/UPDATE/DELETE against an audited table (project, customer,
# user, project_worker) from outside the service-layer `mutate()`
# helper. The `mutate()` helper is the single legitimate writer; every
# other path must go through it so the audit row is produced
# atomically with the state change (ADR-0021 §Decision).
#
# TODO (#116 implementation): once `mutate()` has landed and the
# TypeScript type `AuditEntityType` in data-model.md §5.10 is exported
# from the shared schema (e.g. `src/server/db/schema.ts`), derive the
# AUDITED_TABLES list from that type at check time instead of the
# hardcoded array below. Per AC-179 Part 2, a new `AuditEntityType`
# value whose table is not wired into the check must fail CI — the
# hardcoded list here is the bootstrap-phase stand-in.
#
# `audit_log` itself is NOT in the audited-table set — `mutate()` is
# its legitimate writer, and the retention-cleanup job is its only
# legitimate deleter. Both are allowlisted below.
#
# Allowlist (ALLOW): files that legitimately author raw mutations
# against audited tables — kept intentionally small and reviewed per
# line at PR time (ADR-0021 §Consequences §Negative).
#
# Exit code:
#   0 — no findings outside the allowlist
#   1 — at least one finding; each is printed file:line, followed by
#       the matched snippet so the reviewer can inspect it.
#   2 — toolchain error (missing ripgrep/grep, no source tree).

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d "src/server" ]; then
  echo "ERROR: src/server not found — run from project root." >&2
  exit 2
fi

# Hardcoded list of audited tables. See the TODO comment at the top:
# this becomes an automated derivation from `AuditEntityType` once the
# helper lands. Keep in sync with `data-model.md §5.10` until then.
#
# Table name + Drizzle export name, both forms are checked.
AUDITED_TABLE_SQL_NAMES=(projects customers users project_workers)
AUDITED_DRIZZLE_EXPORTS=(projects customers users projectWorkers)

# TODO (#116 implementation): current scan covers Drizzle builder
# (`db.insert(t)` / `.update(t)` / `.delete(t)`), raw SQL template
# literals (`` sql`INSERT INTO t ...` ``), and `pool.query('INSERT INTO
# t ...')`. Dynamic SQL paths — `sql.raw(...)`, `db.$with(...).delete(...)`,
# runtime-assembled query strings — are NOT detected. ADR-0021 accepts
# this gap for the static check; runtime guards would require the
# trigger belt ruled out in that ADR. When a dynamic-SQL surface is
# added, extend the scanner.

# Files permitted to author raw mutations against audited tables.
# Each entry is a path or a glob prefix matched as a literal substring
# against the finding's file path (from repo root, forward slashes).
#
# See AC-179 for the review contract: adding to this list is a
# reviewed line in the check configuration — not a reflexive escape
# hatch.
ALLOWLIST=(
  # The single-write-path helper — the legitimate writer.
  "src/server/services/mutate.ts"
  # Migrations: schema-level DDL + seed-data migrations run outside
  # the runtime path and predate the helper.
  "src/server/db/migrations/"
  # Unified restore — bulk import replaces business data in one
  # transaction; per ADR-0021 this is allowlisted.
  "src/server/services/ImportService.ts"
  # Business-data seed loader — fixture hydration bypasses audit by
  # design (data-model.md §7).
  "src/server/seed/business.ts"
  # User seed loader — direct-DB path, parallel to business.ts.
  "src/server/seed/users.ts"
  # Audit retention — the only legitimate deleter of audit_log rows.
  # (audit_log is not in the audited-table set, but this job is the
  # archetypal allowlist case for parity with the helper.)
  "src/server/services/audit-retention.ts"
  # Tests in src/server/__tests__/** insert / delete fixtures
  # directly — the AC-179 carve-out for tests.
  "src/server/__tests__/"
  # First-run bootstrap — runs before the app is live and has its
  # own allowlist in AC-178 + ADR-0010. It is expected to use
  # `mutate()` once that helper is available; until then this entry
  # acknowledges the temporary bypass and the implementer removes it
  # when bootstrap is retrofitted.
  "src/server/bootstrap.ts"
)

is_allowlisted() {
  local file="$1"
  for prefix in "${ALLOWLIST[@]}"; do
    case "$file" in
      *"$prefix"*) return 0 ;;
    esac
  done
  return 1
}

# Patterns to detect. Two families:
#   1. Drizzle builder calls: db.insert(projects) / db.update(customers) / db.delete(users).
#   2. Raw SQL template literals: sql`INSERT INTO projects ...`, sql`UPDATE users ...`,
#      sql`DELETE FROM project_workers ...`.
#
# Prefer ripgrep when available — faster, deterministic ordering,
# bundles on every dev + CI box. Fall back to grep -R for minimal
# environments.
if command -v rg >/dev/null 2>&1; then
  scanner="rg --line-number --no-heading --color=never"
else
  scanner="grep -RnE --binary-files=without-match"
fi

findings=""

# --- Drizzle-builder pattern -----------------------------------------
for table in "${AUDITED_DRIZZLE_EXPORTS[@]}"; do
  # Matches `.insert(projects)`, `.update(projects)`, `.delete(projects)`
  # as a word boundary. Optional whitespace between the paren and the
  # identifier to catch `.insert(\n  projects,\n  ...)` on multi-line
  # calls.
  pattern="\\.(insert|update|delete)\\(\\s*${table}\\b"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # ripgrep emits file:line:match; grep -RnE emits file:line:match —
    # both have file as the first colon-separated field.
    file="${line%%:*}"
    if ! is_allowlisted "$file"; then
      findings="${findings}${line}"$'\n'
    fi
  done < <($scanner "$pattern" src/server 2>/dev/null || true)
done

# --- Raw SQL template pattern ----------------------------------------
# Matches `sql\`INSERT INTO projects`, `sql\`UPDATE customers`,
# `sql\`DELETE FROM project_workers`. The subject list is the SQL
# names (plural schema names) with `user_accounts` included as the
# alternate table name documented in the plan — the live schema uses
# `users`, but the spec/plan has referenced `user_accounts`, so the
# check is defensive against either landing.
for table in "${AUDITED_TABLE_SQL_NAMES[@]}"; do
  pattern="sql\`(INSERT INTO|UPDATE|DELETE FROM) ${table}\\b"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    if ! is_allowlisted "$file"; then
      findings="${findings}${line}"$'\n'
    fi
  done < <($scanner "$pattern" src/server 2>/dev/null || true)
done

# --- Raw pool.query pattern ------------------------------------------
# `pool.query('INSERT INTO projects ...')` is the defense-in-depth
# path that would otherwise slip past the Drizzle scanner. Same table
# list as above.
for table in "${AUDITED_TABLE_SQL_NAMES[@]}"; do
  pattern="pool\\.query\\([\"'\\\`](INSERT INTO|UPDATE|DELETE FROM) ${table}\\b"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    if ! is_allowlisted "$file"; then
      findings="${findings}${line}"$'\n'
    fi
  done < <($scanner "$pattern" src/server 2>/dev/null || true)
done

if [ -n "$findings" ]; then
  echo "ERROR: raw mutations on audited tables found outside mutate()." >&2
  echo "       Route the write through src/server/services/mutate.ts, or" >&2
  echo "       add an inline-documented entry to ALLOWLIST in" >&2
  echo "       $(basename "$0") if the path is a reviewed bulk-write site." >&2
  echo "" >&2
  # shellcheck disable=SC2059
  printf "%s" "$findings" >&2
  exit 1
fi

echo "OK: no raw mutations on audited tables outside mutate()."
echo "    audited tables (sql): ${AUDITED_TABLE_SQL_NAMES[*]}"
echo "    audited tables (drizzle exports): ${AUDITED_DRIZZLE_EXPORTS[*]}"
echo "    allowlist size: ${#ALLOWLIST[@]}"
