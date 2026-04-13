/**
 * Authentication state — login, logout, session management.
 *
 * Separated from project and UI state so auth concerns don't
 * pollute other stores, and so the login flow can be tested independently.
 */

import { create } from 'zustand';
import { authApi, type AuthUser } from '@/api/client';
import { STRINGS } from '@/config/strings';
import { useProjectStore } from './projectStore';
import { useUIStore } from './uiStore';
import { useCustomerStore } from './customerStore';
import { useUserStore } from './userStore';
import { useProjectManagementStore } from './projectManagementStore';
import { useImportExportStore } from './importExportStore';

interface AuthState {
  authUser: AuthUser | null;
  authError: string | null;
  sessionChecked: boolean;

  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  handleSessionExpired: () => void;
}

/**
 * Reset downstream state when the user is no longer authenticated.
 *
 * Runs for BOTH the interactive logout path AND the
 * handleSessionExpired path — before this fix, only the interactive
 * logout cleared downstream stores, so a mid-session expiry left the
 * project list, selected project, filter, and view state populated in
 * memory. That data was re-rendered the instant the next user logged
 * in, a same-tab cross-session leak that the review (C F-6) flagged
 * as a latent privacy concern.
 *
 * Kept inside authStore rather than imported from store.ts to avoid
 * the circular-via-barrel pattern: projectStore already imports
 * authStore for handleSessionExpired, and a second path through
 * store.ts would add another leg to the cycle for no gain.
 */
function clearDownstreamState(): void {
  useProjectStore.setState({
    projects: [],
    mutationInFlight: {},
    mutationError: null,
  });
  useUIStore.setState({
    selectedProjectId: null,
    activeFilter: null,
    filterAgedOnly: false,
    filterNoDates: false,
    activeView: 'kanban',
  });
  useCustomerStore.setState({
    customers: [],
    total: 0,
    loading: false,
    error: null,
  });
  useUserStore.setState({
    users: [],
    total: 0,
    loading: false,
    error: null,
  });
  useProjectManagementStore.setState({
    projects: [],
    customers: [],
    loading: false,
    error: null,
  });
  useImportExportStore.setState({
    importData: null,
    importResult: null,
    importError: null,
    importing: false,
    exportCustomerFilter: '',
    exporting: false,
    exportError: null,
  });
}

export const useAuthStore = create<AuthState>((set) => ({
  authUser: null,
  authError: null,
  sessionChecked: false,

  login: async (username: string, password: string) => {
    set({ authError: null });

    const result = await authApi.login(username, password);

    if (!result.ok) {
      set({ authError: result.error.message || STRINGS.auth.loginFailed });
      return;
    }

    set({
      authUser: result.data.user,
      authError: null,
    });
  },

  logout: async () => {
    await authApi.logout();
    set({
      authUser: null,
      authError: null,
    });
    clearDownstreamState();
  },

  checkSession: async () => {
    const result = await authApi.me();

    if (!result.ok) {
      set({ authUser: null, sessionChecked: true });
      return;
    }

    // /api/auth/me returns `{ user: { ... } }` — same envelope as
    // /api/auth/login (consolidation review E F-7). The shape is
    // still untrusted at runtime (the server is reasonable but this
    // is a network boundary), so validate the critical string fields
    // before committing to the store — the same defensive shape the
    // pre-envelope version kept.
    const user = result.data?.user;
    if (user && typeof user.username === 'string' && typeof user.displayName === 'string') {
      set({ authUser: user, sessionChecked: true });
    } else {
      set({ sessionChecked: true });
    }
  },

  handleSessionExpired: () => {
    set({
      authUser: null,
      authError: STRINGS.auth.sessionExpiredLogin,
      sessionChecked: true,
    });
    clearDownstreamState();
  },
}));
