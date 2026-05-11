/**
 * Customer data state — list, create, update.
 *
 * Follows the same pattern as projectStore: all API communication via
 * the centralized client, session expiry delegated to authStore.
 */

import { create } from 'zustand';
import type { Customer } from '@/domain/types';
import { customerApi, type CustomerSortKey, type SortDir } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';
import { useStorageUsageStore } from './storageUsageStore';

// Re-export the sort-key/direction types so UI components reach them
// through the state layer (the API client is off-limits to UI per
// ESLint `no-restricted-imports`).
export type { CustomerSortKey, SortDir };

/**
 * Options passed to `fetchCustomers`. All optional — calling with no
 * args returns the unfiltered list in default (name ascending) order.
 */
export interface FetchCustomersOpts {
  search?: string;
  sortBy?: CustomerSortKey;
  sortDir?: SortDir;
}

/**
 * Result of `createCustomer`. `'ok'` — row committed (fresh or idempotent
 * replay). `'error'` — generic failure; caller keeps the form open. `'conflict'`
 * — server returned IDEMPOTENCY_CONFLICT; the same client id was already used
 * with a different body, so the form instance is unrecoverable. The caller
 * should close the form and refresh the list.
 */
export type CreateCustomerOutcome = { status: 'ok' } | { status: 'error' } | { status: 'conflict' };

/**
 * Result of `fetchCustomerDetail` — the counts-bearing customer payload
 * from `GET /api/customers/:id`. `null` signals the store already wrote
 * a user-facing error message (or a session-expired redirect has been
 * triggered). The caller should abort its flow when null comes back.
 */
export type CustomerDetail = Customer & {
  projectCount: number;
  archivedProjectCount: number;
};

interface CustomerState {
  customers: Customer[];
  total: number;
  loading: boolean;
  error: string | null;

  fetchCustomers: (opts?: FetchCustomersOpts) => Promise<void>;
  fetchCustomerDetail: (id: string) => Promise<CustomerDetail | null>;
  searchCustomers: (search: string) => Promise<Customer[]>;
  createCustomer: (data: {
    id?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    notes?: string | null;
  }) => Promise<CreateCustomerOutcome>;
  updateCustomer: (
    id: string,
    data: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
  ) => Promise<boolean>;
  deleteCustomer: (id: string) => Promise<boolean>;
  clearError: () => void;
}

export const useCustomerStore = create<CustomerState>((set, get) => ({
  customers: [],
  total: 0,
  loading: false,
  error: null,

  fetchCustomers: async (opts?: FetchCustomersOpts) => {
    set({ loading: true, error: null });
    const params: { search?: string; sortBy?: CustomerSortKey; sortDir?: SortDir } = {};
    if (opts?.search) params.search = opts.search;
    if (opts?.sortBy) params.sortBy = opts.sortBy;
    if (opts?.sortDir) params.sortDir = opts.sortDir;
    const result = await customerApi.list(Object.keys(params).length ? params : undefined);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, error: result.error.message });
      return;
    }

    set({
      customers: result.data.customers,
      total: result.data.total,
      loading: false,
    });
  },

  searchCustomers: async (search) => {
    const trimmed = search.trim();
    if (!trimmed) return [];
    const result = await customerApi.list({ search: trimmed });
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return [];
    }
    return result.data.customers;
  },

  createCustomer: async (data) => {
    set({ error: null });
    const result = await customerApi.create(data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return { status: 'error' };
      }
      if (result.error.code === 'IDEMPOTENCY_CONFLICT') {
        // The underlying row already exists with a different body. Refresh
        // the list so the user sees what's there, then signal the caller
        // to close its form (the form instance cannot be safely retried).
        //
        // We refresh the list *before* setting the error — `fetchCustomers`
        // resets `error` to null during a list fetch (loading indicator
        // pattern), so the order matters: fetch first, then commit the
        // conflict message to state.
        await get().fetchCustomers();
        set({ error: result.error.message });
        return { status: 'conflict' };
      }
      set({ error: result.error.message });
      return { status: 'error' };
    }

    // Refetch to get consistent list
    await get().fetchCustomers();
    return { status: 'ok' };
  },

  updateCustomer: async (id, data) => {
    set({ error: null });
    const result = await customerApi.update(id, data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    // Update in-place
    set((s) => ({
      customers: s.customers.map((c) => (c.id === id ? result.data : c)),
    }));
    return true;
  },

  deleteCustomer: async (id) => {
    set({ error: null });
    const result = await customerApi.delete(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      customers: s.customers.filter((c) => c.id !== id),
      total: s.total - 1,
    }));
    // Defence in depth alongside the SSE roundtrip — the server emits
    // `storage_usage_changed` post-commit when the atomic archived-
    // project purge cascade moved bytes (AC-270). The customer may
    // have had no archived projects (no event) or the SSE channel may
    // be unhealthy; this refresh keeps the actor's Footer badge /
    // DatenView row current either way. Cheap idempotent GET.
    void useStorageUsageStore.getState().refresh();
    return true;
  },

  fetchCustomerDetail: async (id) => {
    set({ error: null });
    const result = await customerApi.get(id);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return null;
      }
      // Surface the error to the caller; the UI shows it via the store's
      // existing `error` channel. Do not fall back silently — callers
      // depend on this payload for destructive-flow warnings.
      set({ error: result.error.message });
      return null;
    }
    return result.data;
  },

  clearError: () => set({ error: null }),
}));
