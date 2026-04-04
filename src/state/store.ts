import { create } from 'zustand';
import { flushSync } from 'react-dom';
import type { WorkflowState } from '@/config/stateConfig';
import type { Project, SummaryData, ViewMode } from '@/domain/types';
import { getNextState, getPreviousState } from '@/domain/transitions';
import { computeSummary } from '@/domain/summary';
import { mockProjects } from '@/data/mockProjects';

interface AuthUser {
  username: string;
  displayName: string;
  [key: string]: unknown;
}

interface ProjectStore {
  projects: Project[];
  activeFilter: WorkflowState | null;
  activeView: ViewMode;
  selectedProjectId: string | null;

  // Auth state
  authUser: AuthUser | null;
  authToken: string | null;
  authError: string | null;
  mutationError: string | null;
  mutationInFlight: Record<string, boolean>;
  sessionChecked: boolean;

  // Auth actions
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  fetchProjects: () => Promise<void>;

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
  isMutationInFlight: (projectId: string) => boolean;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [...mockProjects],
  activeFilter: null,
  activeView: 'kanban',
  selectedProjectId: null,

  authUser: null,
  authToken: null,
  authError: null,
  mutationError: null,
  mutationInFlight: {},
  sessionChecked: false,

  login: async (username: string, password: string) => {
    set({ authError: null });
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        set({ authError: data.message ?? 'Anmeldung fehlgeschlagen' });
        return;
      }

      const data = await res.json();
      set({
        authUser: data.user,
        authToken: data.token,
        authError: null,
      });
    } catch {
      set({ authError: 'Anmeldung fehlgeschlagen' });
    }
  },

  logout: async () => {
    const { authToken } = get();
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
      });
    } catch {
      // Logout even if the API call fails
    }
    set({
      authUser: null,
      authToken: null,
      authError: null,
      mutationError: null,
      projects: [],
      selectedProjectId: null,
      activeFilter: null,
      activeView: 'kanban',
    });
  },

  checkSession: async () => {
    try {
      const { authToken } = get();
      const res = await fetch('/api/auth/me', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
      });

      if (!res.ok) {
        set({ authUser: null, authToken: null, sessionChecked: true });
        return;
      }

      const data = await res.json();

      if (data && typeof data.username === 'string' && typeof data.displayName === 'string') {
        set({
          authUser: data,
          sessionChecked: true,
        });
      } else {
        set({ sessionChecked: true });
      }
    } catch {
      set({ sessionChecked: true });
    }
  },

  fetchProjects: async () => {
    const { authToken } = get();
    try {
      const res = await fetch('/api/projects', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
      });

      if (!res.ok) return;

      const body = await res.json();
      set({ projects: body.data ?? body });
    } catch {
      // Silently fail — projects remain as-is
    }
  },

  transitionForward: (projectId: string) => {
    const state = get();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return;

    const next = getNextState(project.status);
    if (!next) return;

    set((s) => ({
      mutationInFlight: { ...s.mutationInFlight, [projectId]: true },
      mutationError: null,
    }));

    const { authToken } = get();
    fetch(`/api/projects/${projectId}/transition/forward`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));

          if (res.status === 401 && data.code === 'SESSION_EXPIRED') {
            set({
              authUser: null,
              authToken: null,
              authError: 'Sitzung abgelaufen. Bitte erneut anmelden.',
              projects: [],
              mutationInFlight: {},
              mutationError: null,
              activeFilter: null,
              selectedProjectId: null,
            });
            return;
          }

          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              mutationError: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
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
    const state = get();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return;

    const prev = getPreviousState(project.status);
    if (!prev) return;

    set((s) => ({
      mutationInFlight: { ...s.mutationInFlight, [projectId]: true },
      mutationError: null,
    }));

    const { authToken } = get();
    fetch(`/api/projects/${projectId}/transition/backward`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));

          if (res.status === 401 && data.code === 'SESSION_EXPIRED') {
            set({
              authUser: null,
              authToken: null,
              authError: 'Sitzung abgelaufen. Bitte erneut anmelden.',
              projects: [],
              mutationInFlight: {},
              mutationError: null,
              activeFilter: null,
              selectedProjectId: null,
            });
            return;
          }

          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              mutationError: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
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
    const state = get();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return;

    const originalProject = { ...project };

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

    const { authToken } = get();
    fetch(`/api/projects/${projectId}/dates`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ plannedStart: start, plannedEnd: end }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));

          if (res.status === 401 && data.code === 'SESSION_EXPIRED') {
            set({
              authUser: null,
              authToken: null,
              authError: 'Sitzung abgelaufen. Bitte erneut anmelden.',
              projects: [],
              mutationInFlight: {},
              mutationError: null,
              activeFilter: null,
              selectedProjectId: null,
            });
            return;
          }

          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              projects: s.projects.map((p) =>
                p.id === projectId ? originalProject : p,
              ),
              mutationError: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
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
            projects: s.projects.map((p) =>
              p.id === projectId ? originalProject : p,
            ),
            mutationError: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
            mutationInFlight: rest,
          };
        });
      });
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

  isMutationInFlight: (projectId: string) => {
    return !!get().mutationInFlight[projectId];
  },
}));
