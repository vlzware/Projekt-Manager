/**
 * Notification rule state — admin CRUD (ui/management.md §8.14).
 *
 * Mirrors the `userStore` shape. The rule set is small (< 20 rows in
 * practice) and the surface is admin-only, so the store holds the full
 * list in memory and refetches after every mutation. Pagination hooks
 * can be added if the volume grows.
 */

import { create } from 'zustand';
import { notificationRuleApi } from '@/api/client';
import type { NotificationRule, NotificationRuleInput } from '@/domain/notifications';
import { handleSessionExpired } from './sessionExpired';

interface NotificationRuleState {
  rules: NotificationRule[];
  total: number;
  loading: boolean;
  error: string | null;

  fetchRules: () => Promise<void>;
  createRule: (data: NotificationRuleInput) => Promise<boolean>;
  updateRule: (id: string, data: Partial<NotificationRuleInput>) => Promise<boolean>;
  deleteRule: (id: string) => Promise<boolean>;
  clearError: () => void;
}

export const useNotificationRuleStore = create<NotificationRuleState>((set, get) => ({
  rules: [],
  total: 0,
  loading: false,
  error: null,

  fetchRules: async () => {
    set({ loading: true, error: null });
    const result = await notificationRuleApi.list();

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, error: result.error.message });
      return;
    }

    set({
      rules: result.data.data,
      total: result.data.total,
      loading: false,
    });
  },

  createRule: async (data) => {
    set({ error: null });
    const result = await notificationRuleApi.create(data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    await get().fetchRules();
    return true;
  },

  updateRule: async (id, data) => {
    set({ error: null });
    const result = await notificationRuleApi.update(id, data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      rules: s.rules.map((r) => (r.id === id ? result.data : r)),
    }));
    return true;
  },

  deleteRule: async (id) => {
    set({ error: null });
    const result = await notificationRuleApi.delete(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      rules: s.rules.filter((r) => r.id !== id),
      total: s.total - 1,
    }));
    return true;
  },

  clearError: () => set({ error: null }),
}));
