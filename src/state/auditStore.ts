/**
 * Audit-log client state — list fetching, pagination, filtering.
 *
 * Follows the projectStore / customerStore pattern: all API calls go
 * through the centralized client, session expiry is delegated to
 * `handleSessionExpired`, and any error surfaces on the store's
 * `error` channel.
 *
 * The audit surface is read-only (api.md §14.2.8), so this store
 * exposes no mutation actions — only fetchers and local filter state.
 * Pagination uses an offset window with append-on-next-page semantics
 * so "Ältere anzeigen" can extend the current result without collapsing
 * already-rendered rows (ui/workflow-views.md §8.4.1,
 * ui/management.md §8.13.1).
 */

import { create } from 'zustand';
import type { AuditEntry, AuditListParams } from '@/domain/audit';
import { auditApi } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';

/**
 * Default page size for the audit list. Kept in one place so the
 * global view, the project-feed view, and the "Ältere anzeigen" pager
 * share the same window size.
 */
export const AUDIT_PAGE_SIZE = 50;

interface AuditState {
  /** Currently rendered entries (most recent first). */
  entries: AuditEntry[];
  /** Total rows matching the current filter — server-provided. */
  total: number;
  /** Active filter / pagination parameters for the next fetch. */
  filters: AuditListParams;
  loading: boolean;
  /** True while a "load older" fetch is in flight. */
  loadingMore: boolean;
  error: string | null;

  /**
   * Replace `entries` with a fresh fetch. Resets pagination —
   * callers that change filters should use this path, not append.
   */
  fetchList: (filters?: AuditListParams) => Promise<void>;

  /**
   * Fetch a single entry by id. Returns the entry on success; the
   * caller can use the result to drive a detail-view surface without
   * reaching into the list cache.
   */
  fetchById: (id: string) => Promise<AuditEntry | null>;

  /**
   * Merge `filters` into the current filter state AND refetch. The
   * explicit pattern mirrors the project-management store's
   * search/filter interaction — one call site per user action.
   */
  setFilters: (filters: Partial<AuditListParams>) => Promise<void>;

  /**
   * Fetch the next page (older rows) using the current `limit` and an
   * offset derived from `entries.length`. Appends to `entries`; does
   * not collapse or reorder already-rendered rows (AC-185).
   */
  appendNextPage: () => Promise<void>;

  /** Reset the store to its initial state (e.g. on logout). */
  reset: () => void;
}

/**
 * Monotonic counter used to discard stale fetch responses — identical
 * pattern to `projectStore.ts`. A newer `fetchList` invalidates the
 * previous one so the store never commits a stale response on top of
 * a fresh one.
 */
let fetchSeq = 0;

const initialState = {
  entries: [] as AuditEntry[],
  total: 0,
  filters: { limit: AUDIT_PAGE_SIZE } satisfies AuditListParams,
  loading: false,
  loadingMore: false,
  error: null as string | null,
};

export const useAuditStore = create<AuditState>((set, get) => ({
  ...initialState,

  fetchList: async (filters) => {
    const merged: AuditListParams = {
      ...initialState.filters,
      ...(filters ?? get().filters),
      offset: 0,
    };
    const seq = ++fetchSeq;
    set({ loading: true, error: null, filters: merged });
    const result = await auditApi.list(merged);
    if (seq !== fetchSeq) return;
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, error: result.error.message });
      return;
    }
    set({
      entries: result.data.data,
      total: result.data.total,
      loading: false,
    });
  },

  fetchById: async (id) => {
    set({ error: null });
    const result = await auditApi.get(id);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return null;
      }
      set({ error: result.error.message });
      return null;
    }
    return result.data;
  },

  setFilters: async (filters) => {
    const next = { ...get().filters, ...filters, offset: 0 };
    await get().fetchList(next);
  },

  appendNextPage: async () => {
    const { entries, filters, loadingMore, loading } = get();
    if (loadingMore || loading) return;
    const limit = filters.limit ?? AUDIT_PAGE_SIZE;
    const offset = entries.length;
    if (offset >= get().total && get().total > 0) return;
    set({ loadingMore: true, error: null });
    const result = await auditApi.list({ ...filters, offset, limit });
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loadingMore: false, error: result.error.message });
      return;
    }
    // Dedup by id — the server returns a stable order, but a concurrent
    // write between pages could land the same id in both windows. The
    // AC pins "appends older entries without collapsing", so a dup is
    // a UX bug, not a crash.
    const knownIds = new Set(entries.map((e) => e.id));
    const fresh = result.data.data.filter((e) => !knownIds.has(e.id));
    set((s) => ({
      entries: [...s.entries, ...fresh],
      total: result.data.total,
      loadingMore: false,
    }));
  },

  reset: () => set({ ...initialState, filters: { limit: AUDIT_PAGE_SIZE } }),
}));
