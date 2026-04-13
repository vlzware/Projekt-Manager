/**
 * Project management view state — list with search, create, update.
 *
 * Separate from the Kanban projectStore so management search/filtering
 * does not interfere with the Kanban board's full project list.
 */

import { create } from 'zustand';
import type { Project, Customer } from '@/domain/types';
import { projectApi, customerApi } from '@/api/client';
import { useAuthStore } from './authStore';
import { useProjectStore } from './projectStore';

interface ProjectManagementState {
  projects: Project[];
  customers: Customer[];
  loading: boolean;
  error: string | null;

  fetchProjects: (search?: string) => Promise<void>;
  fetchCustomers: () => Promise<void>;
  createProject: (data: { number: string; title: string; customerId: string }) => Promise<boolean>;
  updateProject: (id: string, data: { notes?: string | null }) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<boolean>;
  clearError: () => void;
}

function handleSessionExpired() {
  useAuthStore.getState().handleSessionExpired();
}

export const useProjectManagementStore = create<ProjectManagementState>((set, get) => ({
  projects: [],
  customers: [],
  loading: false,
  error: null,

  fetchProjects: async (search?: string) => {
    set({ loading: true, error: null });
    const result = await projectApi.list(search ? { search } : undefined);

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

  fetchCustomers: async () => {
    const result = await customerApi.list();
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return;
    }
    set({ customers: result.data.customers });
  },

  createProject: async (data) => {
    set({ error: null });
    const result = await projectApi.create(data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    // Refetch management list and also refresh the kanban store
    await get().fetchProjects();
    useProjectStore.getState().fetchProjects();
    return true;
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

    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
    }));
    useProjectStore.getState().fetchProjects();
    return true;
  },

  clearError: () => set({ error: null }),
}));
