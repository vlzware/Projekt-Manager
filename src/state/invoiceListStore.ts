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
import { invoicesApi, type ListInvoicesParams } from '@/api/client';
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

  setFilter: <K extends keyof InvoiceListFilters>(key: K, value: InvoiceListFilters[K]) => void;
  fetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
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

  setFilter: (key, value) => {
    set((s) => ({ filters: { ...s.filters, [key]: value } }));
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
}));
