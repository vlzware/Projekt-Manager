/**
 * Project data state — fetching, mutations, optimistic updates.
 *
 * All API communication goes through the centralized API client.
 * Session expiry is detected by the client and delegated to the auth store.
 */

import { create } from 'zustand';
import { flushSync } from 'react-dom';
import type { WorkflowState } from '@/config/stateConfig';
import type { Project, SummaryData } from '@/domain/types';
import { getNextState, getPreviousState } from '@/domain/transitions';
import { computeSummary } from '@/domain/summary';
import { projectApi } from '@/api/client';
import { useAuthStore } from './authStore';

interface ProjectState {
  projects: Project[];
  mutationError: string | null;
  mutationInFlight: Record<string, boolean>;

  fetchProjects: () => Promise<void>;
  transitionForward: (projectId: string) => void;
  transitionBackward: (projectId: string) => void;
  updateDates: (projectId: string, start?: string | null, end?: string | null) => void;
  clearMutationError: () => void;

  getProjectsByState: (state: WorkflowState) => Project[];
  getSummary: () => SummaryData;
  isMutationInFlight: (projectId: string) => boolean;
}

function handleSessionExpired() {
  useAuthStore.getState().handleSessionExpired();
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  mutationError: null,
  mutationInFlight: {},

  fetchProjects: async () => {
    const result = await projectApi.list();
    if (!result.ok) return;
    set({ projects: result.data.data ?? result.data });
  },

  transitionForward: (projectId: string) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const next = getNextState(project.status);
    if (!next) return;

    set((s) => ({
      mutationInFlight: { ...s.mutationInFlight, [projectId]: true },
      mutationError: null,
    }));

    projectApi
      .transitionForward(projectId)
      .then((result) => {
        if (!result.ok) {
          if (result.sessionExpired) {
            handleSessionExpired();
            return;
          }
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              mutationError: result.error.message,
              mutationInFlight: rest,
            };
          });
          return;
        }

        // Re-enable controls first (flushSync forces React to commit the
        // enabled state to the DOM before the card moves to a new column).
        flushSync(() => {
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return { mutationInFlight: rest };
          });
        });
        // Then apply the status change — card moves to new column
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId) return p;
            return {
              ...p,
              status: next,
              statusChangedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      })
      .catch(() => {
        set((s) => {
          const { [projectId]: _, ...rest } = s.mutationInFlight;
          return {
            mutationError: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
            mutationInFlight: rest,
          };
        });
      });
  },

  transitionBackward: (projectId: string) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const prev = getPreviousState(project.status);
    if (!prev) return;

    set((s) => ({
      mutationInFlight: { ...s.mutationInFlight, [projectId]: true },
      mutationError: null,
    }));

    projectApi
      .transitionBackward(projectId)
      .then((result) => {
        if (!result.ok) {
          if (result.sessionExpired) {
            handleSessionExpired();
            return;
          }
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              mutationError: result.error.message,
              mutationInFlight: rest,
            };
          });
          return;
        }

        set((s) => {
          const { [projectId]: _, ...rest } = s.mutationInFlight;
          return {
            projects: s.projects.map((p) => {
              if (p.id !== projectId) return p;
              return {
                ...p,
                status: prev,
                statusChangedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
            }),
            mutationInFlight: rest,
          };
        });
      })
      .catch(() => {
        set((s) => {
          const { [projectId]: _, ...rest } = s.mutationInFlight;
          return {
            mutationError: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
            mutationInFlight: rest,
          };
        });
      });
  },

  updateDates: (projectId: string, start?: string | null, end?: string | null) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const originalProject = { ...project };

    // Optimistic update
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          plannedStart: start === null ? undefined : start !== undefined ? start : p.plannedStart,
          plannedEnd: end === null ? undefined : end !== undefined ? end : p.plannedEnd,
          updatedAt: new Date().toISOString(),
        };
      }),
      mutationInFlight: { ...s.mutationInFlight, [projectId]: true },
      mutationError: null,
    }));

    projectApi
      .updateDates(projectId, { plannedStart: start, plannedEnd: end })
      .then((result) => {
        if (!result.ok) {
          if (result.sessionExpired) {
            handleSessionExpired();
            return;
          }
          // Revert optimistic update
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              projects: s.projects.map((p) => (p.id === projectId ? originalProject : p)),
              mutationError: result.error.message,
              mutationInFlight: rest,
            };
          });
          return;
        }

        set((s) => {
          const { [projectId]: _, ...rest } = s.mutationInFlight;
          return { mutationInFlight: rest };
        });
      })
      .catch(() => {
        set((s) => {
          const { [projectId]: _, ...rest } = s.mutationInFlight;
          return {
            projects: s.projects.map((p) => (p.id === projectId ? originalProject : p)),
            mutationError: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
            mutationInFlight: rest,
          };
        });
      });
  },

  clearMutationError: () => {
    set({ mutationError: null });
  },

  getProjectsByState: (state: WorkflowState) => {
    return get().projects.filter((p) => p.status === state);
  },

  getSummary: () => {
    return computeSummary(get().projects);
  },

  isMutationInFlight: (projectId: string) => {
    return !!get().mutationInFlight[projectId];
  },
}));
