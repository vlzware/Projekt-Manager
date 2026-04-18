/**
 * Project data state — fetching, mutations, optimistic updates.
 *
 * All API communication goes through the centralized API client.
 * Session expiry is detected by the client and delegated to the auth store.
 */

import { create } from 'zustand';
import { flushSync } from 'react-dom';
import { STRINGS } from '@/config/strings';
import type { WorkflowState } from '@/config/stateConfig';
import type { Project, SummaryData } from '@/domain/types';
import { getNextState, getPreviousState } from '@/domain/transitions';
import { computeSummary } from '@/domain/summary';
import { projectApi, type ApiResult } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';
import { useProjectManagementStore } from './projectManagementStore';

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

/** Monotonic counter to discard stale fetch responses. */
let fetchSeq = 0;

export const useProjectStore = create<ProjectState>((set, get) => {
  /**
   * Shared transition runner used by both forward and backward transitions.
   *
   * The two directions used to be near-duplicate methods. They differ only in:
   *   - which `getNextState`/`getPreviousState` to call
   *   - which `projectApi.transition*` to invoke
   * Everything else (in-flight tracking, optimistic-style commit, error
   * handling, session-expiry delegation) is identical.
   *
   * `flushSync` is used unconditionally on success: in the forward case the
   * card moves to a new column, and React must commit the re-enabled
   * controls to the DOM *before* the layout shift; in the backward case the
   * cost is negligible and consistency is more valuable than micro-perf.
   */
  function runTransition(
    projectId: string,
    computeNext: (current: WorkflowState) => WorkflowState | null,
    apiCall: (id: string, expectedStatus: WorkflowState) => Promise<ApiResult<Project>>,
  ): void {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const next = computeNext(project.status);
    if (!next) return;

    set((s) => ({
      mutationInFlight: { ...s.mutationInFlight, [projectId]: true },
      mutationError: null,
    }));

    apiCall(projectId, project.status)
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
          // NOT_FOUND on a mutation means the local cache is out of sync
          // with the server (the project was deleted or never existed).
          // Refetch the list so the stale card disappears and the user
          // sees the real state. Matches api.md §14.4.1's Client behavior
          // column for the Not Found category.
          if (result.category === 'not_found') {
            void get().fetchProjects();
          }
          return;
        }

        // Use the server response data — it has the authoritative status,
        // timestamps, and updatedBy. Client-computed values would drift
        // from the DB due to clock skew and miss server-side fields.
        const updated = result.data;

        // Re-enable controls first (flushSync forces React to commit the
        // enabled state to the DOM before the card moves to a new column).
        flushSync(() => {
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return { mutationInFlight: rest };
          });
        });
        // Then apply the server response — card moves to new column.
        set((s) => ({
          projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
        }));
        // Sync the management store so both views stay consistent.
        useProjectManagementStore.getState().fetchProjects();
      })
      .catch(() => {
        set((s) => {
          const { [projectId]: _, ...rest } = s.mutationInFlight;
          return {
            mutationError: STRINGS.errors.mutationFailed,
            mutationInFlight: rest,
          };
        });
      });
  }

  return {
    projects: [],
    mutationError: null,
    mutationInFlight: {},

    fetchProjects: async () => {
      const seq = ++fetchSeq;
      const result = await projectApi.list();
      // Discard if a newer fetch was initiated while this one was in flight
      if (seq !== fetchSeq) return;
      if (!result.ok) return;
      set({ projects: result.data.data ?? result.data });
    },

    transitionForward: (projectId: string) => {
      runTransition(projectId, getNextState, projectApi.transitionForward);
    },

    transitionBackward: (projectId: string) => {
      runTransition(projectId, getPreviousState, projectApi.transitionBackward);
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
            plannedStart: start === null ? null : (start ?? p.plannedStart),
            plannedEnd: end === null ? null : (end ?? p.plannedEnd),
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
            // NOT_FOUND on a date edit: the project disappeared from the
            // server. Refetch to drop the stale card from the local list
            // (see note in runTransition).
            if (result.category === 'not_found') {
              void get().fetchProjects();
            }
            return;
          }

          // Replace optimistic data with server response
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              projects: s.projects.map((p) => (p.id === projectId ? result.data : p)),
              mutationInFlight: rest,
            };
          });
          // Sync the management store
          useProjectManagementStore.getState().fetchProjects();
        })
        .catch(() => {
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              projects: s.projects.map((p) => (p.id === projectId ? originalProject : p)),
              mutationError: STRINGS.errors.mutationFailed,
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
  };
});
