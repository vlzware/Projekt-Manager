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

interface CustomerState {
  customers: Customer[];
  total: number;
  loading: boolean;
  error: string | null;

  fetchCustomers: (search?: string) => Promise<void>;
  createCustomer: (data: {
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    notes?: string | null;
  }) => Promise<boolean>;
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

  createCustomer: async (data) => {
    set({ error: null });
    const result = await customerApi.create(data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    // Refetch to get consistent list
    await get().fetchCustomers();
    return true;
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

  clearError: () => set({ error: null }),
}));
