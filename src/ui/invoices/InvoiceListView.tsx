/**
 * Standalone /rechnungen list view (ui/invoices.md §8.16.1).
 *
 * Cross-project, paginated table with year/status/search filters and the
 * Storno grouping rule shared with the per-project block (see
 * `@/domain/invoiceGrouping`). Permission gating mirrors the route guard
 * in `App.tsx` — defense in depth; the server's repository predicate
 * (ADR-0019) is authoritative.
 *
 * The row's `Öffnen` action navigates to `/projects/:id` (the per-project
 * detail page) rather than `/rechnungen/:id` — the per-invoice viewer
 * surface is deferred to a follow-up (Chunk D backlog). The PDF download
 * affordance lives inline on each non-draft row.
 *
 * Mutate actions (create / edit / issue / cancel) are NOT exposed here —
 * those live on the per-project block (Chunk B). This surface is
 * read-mostly per the spec's "Future-work seam" note.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { usePermission } from '@/hooks/usePermission';
import { orderInvoicesWithStornoGrouping } from '@/domain/invoiceGrouping';
import { useInvoiceListStore } from '@/state/invoiceListStore';
import { NotPermittedView } from '@/ui/common/NotPermittedView';
import { InvoiceListFilterBar } from './InvoiceListFilterBar';
import { InvoiceListRow } from './InvoiceListRow';
import styles from './InvoiceListView.module.css';

const SEARCH_DEBOUNCE_MS = 250;

/** Years offered in the filter — every distinct year present in the
 *  visible list plus the current calendar year, descending. The current
 *  year is always included so a user can pre-filter for "this year"
 *  before any invoice has been issued. */
function yearsFromInvoices(issueDates: readonly (string | null)[]): readonly number[] {
  const set = new Set<number>();
  set.add(new Date().getFullYear());
  for (const iso of issueDates) {
    if (!iso) continue;
    const year = Number(iso.slice(0, 4));
    if (Number.isFinite(year)) set.add(year);
  }
  return Array.from(set).sort((a, b) => b - a);
}

export function InvoiceListView() {
  const canRead = usePermission('invoice:read');

  const filters = useInvoiceListStore((s) => s.filters);
  const invoices = useInvoiceListStore((s) => s.invoices);
  const total = useInvoiceListStore((s) => s.total);
  const loading = useInvoiceListStore((s) => s.loading);
  const error = useInvoiceListStore((s) => s.error);
  const initialLoad = useInvoiceListStore((s) => s.initialLoad);
  const setFilter = useInvoiceListStore((s) => s.setFilter);
  const fetch = useInvoiceListStore((s) => s.fetch);
  const fetchMore = useInvoiceListStore((s) => s.fetchMore);

  // Local controlled-input mirror for the search field. The store value
  // updates on the debounce tick — typing always renders immediately, but
  // the GET only fires after the user stops for `SEARCH_DEBOUNCE_MS`.
  const [searchInput, setSearchInput] = useState(filters.search);

  // Initial fetch. Subsequent fetches are triggered by filter changes
  // (see below) and by the SSE subscription in App.tsx.
  useEffect(() => {
    if (!canRead) return;
    void fetch();
  }, [canRead, fetch]);

  // Year / status changes are discrete clicks → fire immediately.
  const prevYear = useRef(filters.year);
  const prevStatus = useRef(filters.status);
  useEffect(() => {
    if (prevYear.current === filters.year && prevStatus.current === filters.status) return;
    prevYear.current = filters.year;
    prevStatus.current = filters.status;
    void fetch();
  }, [filters.year, filters.status, fetch]);

  // Search is debounced to avoid hammering the endpoint while typing.
  useEffect(() => {
    if (searchInput === filters.search) return;
    const timer = setTimeout(() => {
      setFilter('search', searchInput);
      void fetch();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, filters.search, setFilter, fetch]);

  const years = useMemo(() => yearsFromInvoices(invoices.map((i) => i.issueDate)), [invoices]);

  const ordered = useMemo(() => orderInvoicesWithStornoGrouping(invoices), [invoices]);

  // Storno display lookup — the row needs the original's `number` to
  // render the `Storno zu RE-…` subline.
  const invoicesById = useMemo(() => {
    const map = new Map<string, (typeof invoices)[number]>();
    for (const inv of invoices) map.set(inv.id, inv);
    return map;
  }, [invoices]);

  if (!canRead) return <NotPermittedView />;

  const showEmpty = !initialLoad && !loading && ordered.length === 0;
  const hasMore = invoices.length < total;

  return (
    <div className={styles.container} data-testid="invoice-list-view">
      <InvoiceListFilterBar
        years={years}
        year={filters.year}
        status={filters.status}
        search={searchInput}
        onYearChange={(y) => setFilter('year', y)}
        onStatusChange={(s) => setFilter('status', s)}
        onSearchChange={setSearchInput}
      />

      {error && (
        <div className={styles.error} role="status">
          {error}
        </div>
      )}

      {showEmpty ? (
        <div className={styles.empty} data-testid="invoice-list-empty">
          {STRINGS.invoices.listEmpty}
        </div>
      ) : (
        <div className={styles.list} data-testid="invoice-list-cross-project">
          {ordered.map((invoice) => (
            <InvoiceListRow
              key={invoice.id}
              invoice={invoice}
              originalNumber={
                invoice.cancellationOf
                  ? (invoicesById.get(invoice.cancellationOf)?.number ?? null)
                  : null
              }
            />
          ))}
        </div>
      )}

      {hasMore && (
        <button
          type="button"
          className={styles.loadMore}
          onClick={() => void fetchMore()}
          disabled={loading}
          data-testid="invoice-list-load-more"
        >
          {STRINGS.invoices.loadMore}
        </button>
      )}
    </div>
  );
}
