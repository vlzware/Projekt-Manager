/**
 * Client-side ordering helper for the Storno-sibling display rule
 * (ui/invoices.md §8.16.1). Both the per-project block and the
 * cross-project list view consume this so the visual grouping stays
 * identical across surfaces.
 *
 * The server returns rows by `issueDate DESC, createdAt DESC` — for an
 * original + Storno issued on the same day, that puts the Storno (newer
 * createdAt) ABOVE the original; the spec wants the inverse, with the
 * Storno visually subordinated UNDER its `cancellationOf` original.
 *
 * Algorithm: emit each non-Storno (or orphan) row in input order, then
 * splice in every Storno sibling that references that row. Orphan
 * Stornos — `cancellationOf` resolves to nothing in the current snapshot,
 * which shouldn't happen in practice but keeps total-coverage on a stale
 * list — fall back to server order at the end.
 */

import type { Invoice } from './invoice';

export function orderInvoicesWithStornoGrouping(invoices: readonly Invoice[]): Invoice[] {
  const seen = new Set<string>();
  const result: Invoice[] = [];
  for (const inv of invoices) {
    if (seen.has(inv.id)) continue;
    if (inv.cancellationOf) continue;
    result.push(inv);
    seen.add(inv.id);
    for (const sibling of invoices) {
      if (sibling.cancellationOf === inv.id && !seen.has(sibling.id)) {
        result.push(sibling);
        seen.add(sibling.id);
      }
    }
  }
  for (const inv of invoices) {
    if (!seen.has(inv.id)) result.push(inv);
  }
  return result;
}
