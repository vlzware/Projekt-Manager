/**
 * UI state — view mode, filters, selection.
 *
 * Local-only state that never touches the API.
 * Separated so view concerns don't trigger project refetches.
 *
 * Filters are mutually exclusive: a workflow-state filter and a "no dates"
 * filter cannot both be active. Setting one clears the other. Switching
 * views clears every filter.
 */

import { create } from 'zustand';
import type { WorkflowState } from '@/config/stateConfig';
import type { ViewMode } from '@/domain/types';

interface UIState {
  activeFilter: WorkflowState | null;
  filterAgedOnly: boolean;
  filterNoDates: boolean;
  activeView: ViewMode;
  selectedProjectId: string | null;

  setFilter: (state: WorkflowState | null, agedOnly?: boolean) => void;
  setFilterNoDates: (value: boolean) => void;
  clearFilters: () => void;
  setView: (view: ViewMode) => void;
  selectProject: (projectId: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeFilter: null,
  filterAgedOnly: false,
  filterNoDates: false,
  activeView: 'kanban',
  selectedProjectId: null,

  setFilter: (filterState: WorkflowState | null, agedOnly = false) => {
    set({ activeFilter: filterState, filterAgedOnly: agedOnly, filterNoDates: false });
  },

  setFilterNoDates: (value: boolean) => {
    set({ filterNoDates: value, activeFilter: null, filterAgedOnly: false });
  },

  clearFilters: () => {
    set({ activeFilter: null, filterAgedOnly: false, filterNoDates: false });
  },

  setView: (view: ViewMode) => {
    set({ activeView: view, activeFilter: null, filterAgedOnly: false, filterNoDates: false });
  },

  selectProject: (projectId: string | null) => {
    set({ selectedProjectId: projectId });
  },
}));
