/**
 * Customer data state — list, create, update.
 *
 * Follows the same pattern as projectStore: all API communication via
 * the centralized client, session expiry delegated to authStore.
 */

import { create } from 'zustand';
import type { Customer } from '@/domain/types';
import { customerApi } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';

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

  fetchCustomers: (search?: string) => Promise<void>;
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

  fetchCustomers: async (search?: string) => {
    set({ loading: true, error: null });
    const result = await customerApi.list(search ? { search } : undefined);

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
