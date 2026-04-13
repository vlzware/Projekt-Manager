/**
 * User management state — list, create, update, deactivate, reactivate.
 *
 * Only accessible to users with user:read / user:manage permissions.
 * Follows the same pattern as projectStore.
 */

import { create } from 'zustand';
import type { User } from '@/domain/types';
import { userApi } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';

interface UserState {
  users: User[];
  total: number;
  loading: boolean;
  error: string | null;

  fetchUsers: () => Promise<void>;
  createUser: (data: {
    username: string;
    displayName: string;
    password: string;
    roles: string[];
    email?: string | null;
  }) => Promise<boolean>;
  updateUser: (
    id: string,
    data: {
      displayName?: string;
      roles?: string[];
      email?: string | null;
    },
  ) => Promise<boolean>;
  deactivateUser: (id: string) => Promise<boolean>;
  reactivateUser: (id: string) => Promise<boolean>;
  clearError: () => void;
}

export const useUserStore = create<UserState>((set, get) => ({
  users: [],
  total: 0,
  loading: false,
  error: null,

  fetchUsers: async () => {
    set({ loading: true, error: null });
    const result = await userApi.list();

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, error: result.error.message });
      return;
    }

    set({
      users: result.data.users,
      total: result.data.total,
      loading: false,
    });
  },

  createUser: async (data) => {
    set({ error: null });
    const result = await userApi.create(data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    await get().fetchUsers();
    return true;
  },

  updateUser: async (id, data) => {
    set({ error: null });
    const result = await userApi.update(id, data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      users: s.users.map((u) => (u.id === id ? result.data : u)),
    }));
    return true;
  },

  deactivateUser: async (id) => {
    set({ error: null });
    const result = await userApi.deactivate(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      users: s.users.map((u) => (u.id === id ? result.data : u)),
    }));
    return true;
  },

  reactivateUser: async (id) => {
    set({ error: null });
    const result = await userApi.reactivate(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      users: s.users.map((u) => (u.id === id ? result.data : u)),
    }));
    return true;
  },

  clearError: () => set({ error: null }),
}));
