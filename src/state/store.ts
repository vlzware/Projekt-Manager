import { create } from 'zustand';
import type { WorkflowState } from '@/config/stateConfig';
import type { Project, SummaryData, ViewMode } from '@/domain/types';
import { getNextState, getPreviousState } from '@/domain/transitions';
import { computeSummary } from '@/domain/summary';
import { mockProjects } from '@/data/mockProjects';

interface ProjectStore {
  projects: Project[];
  activeFilter: WorkflowState | null;
  activeView: ViewMode;
  selectedProjectId: string | null;

  // Actions
  transitionForward: (projectId: string) => void;
  transitionBackward: (projectId: string) => void;
  updateDates: (projectId: string, start?: string | null, end?: string | null) => void;
  setFilter: (state: WorkflowState | null) => void;
  setView: (view: ViewMode) => void;
  selectProject: (projectId: string | null) => void;

  // Selectors
  getProjectsByState: (state: WorkflowState) => Project[];
  getSummary: () => SummaryData;
  getSelectedProject: () => Project | null;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [...mockProjects],
  activeFilter: null,
  activeView: 'kanban',
  selectedProjectId: null,

  transitionForward: (projectId: string) => {
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p;
        const next = getNextState(p.status);
        if (!next) return p;
        return {
          ...p,
          status: next,
          statusChangedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
  },

  transitionBackward: (projectId: string) => {
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p;
        const prev = getPreviousState(p.status);
        if (!prev) return p;
        return {
          ...p,
          status: prev,
          statusChangedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
  },

  updateDates: (projectId: string, start?: string | null, end?: string | null) => {
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          plannedStart: start === null ? undefined : start !== undefined ? start : p.plannedStart,
          plannedEnd: end === null ? undefined : end !== undefined ? end : p.plannedEnd,
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
  },

  setFilter: (filterState: WorkflowState | null) => {
    set({ activeFilter: filterState });
  },

  setView: (view: ViewMode) => {
    set({ activeView: view, activeFilter: null });
  },

  selectProject: (projectId: string | null) => {
    set({ selectedProjectId: projectId });
  },

  getProjectsByState: (state: WorkflowState) => {
    return get().projects.filter((p) => p.status === state);
  },

  getSummary: () => {
    return computeSummary(get().projects);
  },

  getSelectedProject: () => {
    const { projects, selectedProjectId } = get();
    if (!selectedProjectId) return null;
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  },
}));
