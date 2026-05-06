/**
 * Project management view state — list with search, create, update.
 *
 * Separate from the Kanban projectStore so management search/filtering
 * does not interfere with the Kanban board's full project list.
 */

import { create } from 'zustand';
import type { Project, Customer } from '@/domain/types';
import { projectApi, customerApi } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';
import { useProjectStore } from './projectStore';
import { useStorageUsageStore } from './storageUsageStore';

/**
 * Result of `createProject`. Mirrors `CreateCustomerOutcome` — see that
 * type's comment for the meaning of `'conflict'`.
 */
export type CreateProjectOutcome = { status: 'ok' } | { status: 'error' } | { status: 'conflict' };

interface ProjectManagementState {
  projects: Project[];
  customers: Customer[];
  loading: boolean;
  error: string | null;
  /**
   * Whether the list should include archived (soft-deleted) projects.
   * Default `false` — archived rows are hidden. Toggled by the
   * "Archivierte einblenden" checkbox in the management toolbar (AC-152).
   */
  showArchived: boolean;

  fetchProjects: (search?: string) => Promise<void>;
  searchProjects: (search: string) => Promise<Project[]>;
  fetchCustomers: () => Promise<void>;
  setShowArchived: (v: boolean) => void;
  createProject: (data: {
    id?: string;
    number: string;
    title: string;
    customerId: string;
  }) => Promise<CreateProjectOutcome>;
  updateProject: (
    id: string,
    data: {
      title?: string;
      customerId?: string;
      estimatedValue?: number | null;
      notes?: string | null;
    },
  ) => Promise<Project | null>;
  updateDates: (
    id: string,
    dates: { plannedStart?: string | null; plannedEnd?: string | null },
  ) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<boolean>;
  /**
   * Hard-delete an archived project (AC-155..158). Returns:
   *   - true on 204 success (row removed from local state)
   *   - true on 404 — treat as "already gone", remove locally, no error
   *   - false on 409 (not archived) / 403 — surfaces server message
   */
  purgeProject: (id: string) => Promise<boolean>;
  /** Restore an archived project — flips deleted=true back to false. */
  restoreProject: (id: string) => Promise<boolean>;
  clearError: () => void;
}

export const useProjectManagementStore = create<ProjectManagementState>((set, get) => ({
  projects: [],
  customers: [],
  loading: false,
  error: null,
  showArchived: false,

  fetchProjects: async (search?: string) => {
    set({ loading: true, error: null });
    const { showArchived } = get();
    // Build the param bag from current state — omit undefined fields so
    // the server sees only what we actually meant to send.
    const params: { search?: string; includeArchived?: boolean } = {};
    if (search) params.search = search;
    if (showArchived) params.includeArchived = true;
    const result = await projectApi.list(Object.keys(params).length ? params : undefined);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, error: result.error.message });
      return;
    }

    set({ projects: result.data.data, loading: false });
  },

  setShowArchived: (v: boolean) => {
    set({ showArchived: v });
  },

  fetchCustomers: async () => {
    const result = await customerApi.list();
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return;
    }
    set({ customers: result.data.customers });
  },

  searchProjects: async (search) => {
    const trimmed = search.trim();
    if (!trimmed) return [];
    const result = await projectApi.list({ search: trimmed });
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return [];
    }
    return result.data.data;
  },

  createProject: async (data) => {
    set({ error: null });
    const result = await projectApi.create(data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return { status: 'error' };
      }
      if (result.error.code === 'IDEMPOTENCY_CONFLICT') {
        // Refresh the list *before* committing the error message —
        // `fetchProjects` clears `error` while loading.
        await get().fetchProjects();
        useProjectStore.getState().fetchProjects();
        set({ error: result.error.message });
        return { status: 'conflict' };
      }
      set({ error: result.error.message });
      return { status: 'error' };
    }

    // Refetch management list and also refresh the kanban store
    await get().fetchProjects();
    useProjectStore.getState().fetchProjects();
    return { status: 'ok' };
  },

  updateProject: async (id, data) => {
    set({ error: null });
    const result = await projectApi.update(id, data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return null;
      }
      set({ error: result.error.message });
      return null;
    }

    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? result.data : p)),
    }));
    useProjectStore.getState().fetchProjects();
    return result.data;
  },

  updateDates: async (id, dates) => {
    set({ error: null });
    const result = await projectApi.updateDates(id, dates);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return null;
      }
      set({ error: result.error.message });
      return null;
    }

    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? result.data : p)),
    }));
    useProjectStore.getState().fetchProjects();
    return result.data;
  },

  deleteProject: async (id) => {
    set({ error: null });
    const result = await projectApi.delete(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    // Archive is a soft-delete. When the user has "Archivierte einblenden"
    // on, keep the row visible with its archived state flipped so the UI
    // matches a fresh fetch; when off, drop it from the local list.
    set((s) => ({
      projects: s.showArchived
        ? s.projects.map((p) => (p.id === id ? { ...p, deleted: true } : p))
        : s.projects.filter((p) => p.id !== id),
    }));
    useProjectStore.getState().fetchProjects();
    return true;
  },

  purgeProject: async (id) => {
    set({ error: null });
    const result = await projectApi.purge(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      // 404 on purge is a race — another client just removed the row, or
      // the local list is stale. Either way the user's intent ("make it
      // go away") is satisfied; drop the row locally and succeed.
      if (result.category === 'not_found') {
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
        }));
        useProjectStore.getState().fetchProjects();
        return true;
      }
      // 409 CONFLICT (not archived) and 403 NOT_PERMITTED surface the
      // server's German message to the user.
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
    }));
    useProjectStore.getState().fetchProjects();
    // Defence in depth alongside the SSE roundtrip — the server emits
    // `storage_usage_changed` post-commit when the purge cascade moved
    // bytes (AC-270), but if the channel is unhealthy (proxy issue,
    // dropped reconnect) the actor's Footer badge / DatenView row stays
    // current via this same-tab refresh. Mirrors attachmentStore.
    void useStorageUsageStore.getState().refresh();
    return true;
  },

  restoreProject: async (id) => {
    set({ error: null });
    const result = await projectApi.restore(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    // Server returns the now-active project body — write it through both
    // stores so the read-only preview flips back to editable without a
    // refetch round-trip.
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? result.data : p)),
    }));
    useProjectStore.getState().fetchProjects();
    return true;
  },

  clearError: () => set({ error: null }),
}));
