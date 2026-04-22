/**
 * UI state — view mode, filters, selection.
 *
 * Local-only state that never touches the API.
 * Separated so view concerns don't trigger project refetches.
 *
 * The only persistent filter is `filterNoDates`, set from CalendarView's
 * "projects without dates" jump and cleared on view change. Workflow-state
 * filters used to live here too; they were dropped together with the
 * summary-action chips that drove them — Kanban column headers already
 * carry the state-level counts (and aged-buffer warnings), so a global
 * filter on top added noise rather than information.
 */

import { create } from 'zustand';
import type { ViewMode } from '@/domain/types';

interface UIState {
  filterNoDates: boolean;
  activeView: ViewMode;
  selectedProjectId: string | null;

  setFilterNoDates: (value: boolean) => void;
  clearFilters: () => void;
  setView: (view: ViewMode) => void;
  selectProject: (projectId: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  filterNoDates: false,
  activeView: 'kanban',
  selectedProjectId: null,

  setFilterNoDates: (value: boolean) => {
    set({ filterNoDates: value });
  },

  clearFilters: () => {
    set({ filterNoDates: false });
  },

  setView: (view: ViewMode) => {
    set({ activeView: view, filterNoDates: false });
  },

  selectProject: (projectId: string | null) => {
    set({ selectedProjectId: projectId });
  },
}));
