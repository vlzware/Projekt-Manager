/**
 * Cross-project invoice list state (ui/invoices.md §8.16.1).
 *
 * Distinct from `invoiceStore.ts` which is per-project. The standalone
 * `/rechnungen` view has its own filters (year / status / search) and
 * its own paginated cursor — coupling the two stores would force one
 * surface's mutations to invalidate the other's cache.
 *
 * Pagination model: monotonic offset/limit. Each `fetchMore()` issues a
 * GET with the next page's offset and appends to the local cache. The
 * server returns `{ data, total }` so the consumer can stop loading when
 * `invoices.length >= total`. SSE refresh re-runs page 0 only — late
 * pages are discarded because the order may have shifted (a new draft
 * issued on top of the list); re-paginating is the conservative path.
 */

import { create } from 'zustand';
import { invoicesApi, type ExportInvoicesBody, type ListInvoicesParams } from '@/api/client';
import { STRINGS } from '@/config/strings';
import type { Invoice, InvoiceStatus } from '@/domain/invoice';
import { handleSessionExpired } from './sessionExpired';

export const INVOICE_LIST_PAGE_SIZE = 50;

export interface InvoiceListFilters {
  /** Calendar year of `issueDate` (drafts excluded by the year filter server-side). */
  year: number | null;
  status: InvoiceStatus | null;
  /** Free-text — substring match on `number` and recipient name (server-side). */
  search: string;
  /**
   * URL-driven project filter — set by the per-project block's
   * `Alle Rechnungen anzeigen` cross-link (ui/project-detail.md §8.15.11).
   * Not exposed as a user-facing widget; the chip on the toolbar is a
   * read-only indicator that the URL carries `?projectId=…`.
   */
  projectId: string | null;
}

interface InvoiceListState {
  filters: InvoiceListFilters;
  invoices: Invoice[];
  total: number;
  loading: boolean;
  error: string | null;
  /**
   * `false` until the first `fetch()` settles (success or error), then
   * permanently `true`. Distinguishes "never asked" from "asked but still
   * loading"; the empty-state banner must wait for `true` to avoid a
   * flicker while the very first response is in flight.
   */
  hasInitialized: boolean;
  /**
   * Immediate (un-debounced) search-input value. The visible field on
   * the filter bar reads/writes this; a debounce in the view promotes
   * it to `filters.search` after 250 ms of idle. Lifted into the store
   * so `resetFilters()` can clear both atomically — a React-local
   * mirror would re-commit its stale value via the debounce after the
   * filter was reset.
   */
  searchDraft: string;
  /** IDs of invoices currently ticked for bulk export. Cleared on every
   *  filter change (the visible set can shift, leaving stale checks). */
  selectedIds: ReadonlySet<string>;
  /** True while `exportZip()` is in flight. Drives the button label. */
  exporting: boolean;
  /** Last export error, or `null`. Cleared on the next export attempt. */
  exportError: string | null;
  /**
   * Distinct issue-date years across the caller's scope. Source for
   * the filter dropdown. Independent of the active filter (otherwise
   * selecting year=N would collapse the dropdown to just N). Populated
   * by `fetchYears()` once on mount and on SSE invalidation.
   */
  availableYears: readonly number[];

  setFilter: <K extends keyof InvoiceListFilters>(key: K, value: InvoiceListFilters[K]) => void;
  setSearchDraft: (value: string) => void;
  fetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
  fetchYears: () => Promise<void>;
  /** Reset every filter (year, status, search, searchDraft) to its
   *  default. The URL-driven `projectId` is not touched here — the
   *  caller strips it from the URL when needed. */
  resetFilters: () => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  /** Replace the selection with the given ids (caller filters drafts out). */
  setSelection: (ids: readonly string[]) => void;
  /**
   * Trigger the bulk-export download. Uses the current selection when
   * non-empty, falls back to the current filter when empty (drafts
   * excluded server-side). Returns the result so the view can drive the
   * actual download side-effect (Blob → anchor click).
   */
  exportZip: () => Promise<{ ok: true; blob: Blob; filename: string } | { ok: false }>;
}

function buildParams(filters: InvoiceListFilters, offset: number): ListInvoicesParams {
  const params: ListInvoicesParams = {
    offset,
    limit: INVOICE_LIST_PAGE_SIZE,
  };
  if (filters.year !== null) params.year = filters.year;
  if (filters.status !== null) params.status = filters.status;
  if (filters.projectId !== null) params.projectId = filters.projectId;
  const trimmed = filters.search.trim();
  if (trimmed.length > 0) params.search = trimmed;
  return params;
}

export const useInvoiceListStore = create<InvoiceListState>((set, get) => ({
  filters: { year: null, status: null, search: '', projectId: null },
  invoices: [],
  total: 0,
  loading: false,
  error: null,
  hasInitialized: false,
  searchDraft: '',
  selectedIds: new Set<string>(),
  exporting: false,
  exportError: null,
  availableYears: [],

  setFilter: (key, value) => {
    // Clear selection on every filter change — the visible set can
    // shift, and leaving stale checks would silently extend exports
    // beyond what the user sees. Also clear any stale export error.
    set((s) => ({
      filters: { ...s.filters, [key]: value },
      selectedIds: new Set(),
      exportError: null,
    }));
  },

  setSearchDraft: (value) => {
    set({ searchDraft: value });
  },

  toggleSelection: (id) => {
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    });
  },

  clearSelection: () => {
    set({ selectedIds: new Set() });
  },

  setSelection: (ids) => {
    set({ selectedIds: new Set(ids) });
  },

  resetFilters: () => {
    set((s) => ({
      filters: { ...s.filters, year: null, status: null, search: '' },
      searchDraft: '',
      selectedIds: new Set(),
      exportError: null,
    }));
  },

  fetchYears: async () => {
    const result = await invoicesApi.listYears();
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return;
    }
    set({ availableYears: result.data.years });
  },

  fetch: async () => {
    set({ loading: true, error: null });
    const params = buildParams(get().filters, 0);
    const result = await invoicesApi.list(params);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, hasInitialized: true, error: result.error.message });
      return;
    }
    set({
      invoices: result.data.data,
      total: result.data.total,
      loading: false,
      hasInitialized: true,
    });
  },

  fetchMore: async () => {
    const { invoices, total, loading } = get();
    if (loading) return;
    if (invoices.length >= total) return;
    set({ loading: true, error: null });
    const params = buildParams(get().filters, invoices.length);
    const result = await invoicesApi.list(params);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, error: result.error.message });
      return;
    }
    set((s) => ({
      invoices: [...s.invoices, ...result.data.data],
      total: result.data.total,
      loading: false,
    }));
  },

  exportZip: async () => {
    const { selectedIds, filters, exporting } = get();
    if (exporting) return { ok: false as const };
    set({ exporting: true, exportError: null });
    const body: ExportInvoicesBody =
      selectedIds.size > 0
        ? { ids: Array.from(selectedIds) }
        : {
            filter: {
              ...(filters.year !== null ? { year: filters.year } : {}),
              ...(filters.status !== null ? { status: filters.status } : {}),
              ...(filters.projectId !== null ? { projectId: filters.projectId } : {}),
              ...(filters.search.trim().length > 0 ? { search: filters.search.trim() } : {}),
            },
          };
    const result = await invoicesApi.exportZip(body);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        set({ exporting: false });
        return { ok: false as const };
      }
      set({ exporting: false, exportError: result.error.message || STRINGS.invoices.exportFailed });
      return { ok: false as const };
    }
    set({ exporting: false, selectedIds: new Set() });
    return { ok: true as const, blob: result.data.blob, filename: result.data.filename };
  },
}));
