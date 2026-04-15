/**
 * Canonical form for case-insensitive, whitespace-tolerant name matching.
 *
 * Used by the customer duplicate-name detection in CustomerManagement so
 * " Ada  Lovelace" and "ada lovelace" collapse to the same key. Kept
 * domain-pure (no React, no store) so it can be called anywhere the same
 * comparison is needed without coupling.
 */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
