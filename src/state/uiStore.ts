/**
 * UI state — view mode, filters, selection.
 *
 * Local-only state that never touches the API.
 * Separated so view concerns don't trigger project refetches.
 */

import { create } from 'zustand';
import type { WorkflowState } from '@/config/stateConfig';
import type { ViewMode } from '@/domain/types';

interface UIState {
  activeFilter: WorkflowState | null;
  activeView: ViewMode;
  selectedProjectId: string | null;

  setFilter: (state: WorkflowState | null) => void;
  setView: (view: ViewMode) => void;
  selectProject: (projectId: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeFilter: null,
  activeView: 'kanban',
  selectedProjectId: null,

  setFilter: (filterState: WorkflowState | null) => {
    set({ activeFilter: filterState });
  },

  setView: (view: ViewMode) => {
    set({ activeView: view, activeFilter: null });
  },

  selectProject: (projectId: string | null) => {
    set({ selectedProjectId: projectId });
  },
}));
