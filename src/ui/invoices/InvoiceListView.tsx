/**
 * Standalone /rechnungen list view (ui/invoices.md §8.16.1).
 *
 * Cross-project, paginated table with year/status/search filters and the
 * Storno grouping rule shared with the per-project block (see
 * `@/domain/invoiceGrouping`). Permission gating mirrors the route guard
 * in `App.tsx` — defense in depth; the server's repository predicate
 * (ADR-0019) is authoritative.
 *
 * Row navigation: draft rows open `/projects/:projectId` (the only
 * surface where a draft is editable); issued / cancelled / Storno rows
 * open `/rechnungen/:id` — the per-invoice viewer (§8.16.3). The PDF
 * download affordance lives inline on each non-draft row.
 *
 * Mutate actions (create / edit / issue / cancel) are NOT exposed here
 * — those live on the per-project block. This surface is read-mostly
 * per the spec's "Future-work seam" note.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { STRINGS } from '@/config/strings';
import { usePermission } from '@/hooks/usePermission';
import { orderInvoicesWithStornoGrouping } from '@/domain/invoiceGrouping';
import { useInvoiceListStore } from '@/state/invoiceListStore';
import { useProjectStore } from '@/state/projectStore';
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
  const hasInitialized = useInvoiceListStore((s) => s.hasInitialized);
  const setFilter = useInvoiceListStore((s) => s.setFilter);
  const fetch = useInvoiceListStore((s) => s.fetch);
  const fetchMore = useInvoiceListStore((s) => s.fetchMore);

  // Local controlled-input mirror for the search field. The store value
  // updates on the debounce tick — typing always renders immediately, but
  // the GET only fires after the user stops for `SEARCH_DEBOUNCE_MS`.
  const [searchInput, setSearchInput] = useState(filters.search);

  // F7 — sync the URL's `?projectId=` query into the store filter so the
  // cross-link from the per-project block lands a pre-filtered view. The
  // chip in the toolbar makes the filter explicit; clearing the chip
  // strips the query and falls through here to reset the filter.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlProjectId = searchParams.get('projectId');
  useEffect(() => {
    if (filters.projectId !== urlProjectId) {
      setFilter('projectId', urlProjectId);
    }
    // We intentionally do not fetch here — the initial-fetch effect below
    // observes the synced filter and dispatches a single GET. Splitting
    // sync + fetch avoids a double-fetch when the view mounts with a URL
    // projectId, and the filter-effect for year/status takes over for
    // subsequent runtime changes.
  }, [urlProjectId, filters.projectId, setFilter]);

  // Project chip resolves number/title from the project store so the user
  // sees *which* project the filter constrains, not just that one is set.
  // Deep-linking /rechnungen?projectId=… may land before the project is
  // cached, so we trigger a fetch when missing — `fetchProject` upserts
  // into the same store the lookup reads from.
  const filterProject = useProjectStore((s) =>
    filters.projectId ? (s.projects.find((p) => p.id === filters.projectId) ?? null) : null,
  );
  const fetchProject = useProjectStore((s) => s.fetchProject);
  useEffect(() => {
    if (!filters.projectId || filterProject) return;
    void fetchProject(filters.projectId);
  }, [filters.projectId, filterProject, fetchProject]);

  // Initial fetch. Subsequent fetches are triggered by the
  // year/status/projectId effects below and by the SSE subscription in
  // App.tsx. The dependency on `filters.projectId` covers the URL-sync
  // path: the URL effect above flushes the filter, then this effect's
  // re-run picks it up.
  useEffect(() => {
    if (!canRead) return;
    void fetch();
    // Initial fetch — triggered by canRead and any URL-driven projectId
    // change. Year/status/search have their own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, filters.projectId]);

  // Year / status changes are discrete clicks → fire immediately.
  const prevYear = useRef(filters.year);
  const prevStatus = useRef(filters.status);
  useEffect(() => {
    if (prevYear.current === filters.year && prevStatus.current === filters.status) return;
    prevYear.current = filters.year;
    prevStatus.current = filters.status;
    void fetch();
  }, [filters.year, filters.status, fetch]);

  const clearProjectFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('projectId');
    setSearchParams(next, { replace: true });
  };

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

  const showEmpty = hasInitialized && !loading && ordered.length === 0;
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

      {filters.projectId && (
        <div className={styles.projectChip} data-testid="invoice-list-project-chip">
          <span className={styles.projectChipLabel}>{STRINGS.invoices.filterProjectChip}</span>
          {filterProject ? (
            <span className={styles.projectChipValue} data-testid="invoice-list-project-chip-name">
              {filterProject.number} — {filterProject.title}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.projectChipClear}
            onClick={clearProjectFilter}
            data-testid="invoice-list-project-chip-clear"
            aria-label={STRINGS.invoices.filterProjectClear}
          >
            {STRINGS.invoices.filterProjectClear}
          </button>
        </div>
      )}

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
