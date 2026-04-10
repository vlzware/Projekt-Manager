/**
 * Authentication state — login, logout, session management.
 *
 * Separated from project and UI state so auth concerns don't
 * pollute other stores, and so the login flow can be tested independently.
 */

import { create } from 'zustand';
import { authApi, type AuthUser } from '@/api/client';
import { STRINGS } from '@/config/strings';

interface AuthState {
  authUser: AuthUser | null;
  authError: string | null;
  sessionChecked: boolean;

  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  handleSessionExpired: () => void;
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
  },

  checkSession: async () => {
    const result = await authApi.me();

    if (!result.ok) {
      set({ authUser: null, sessionChecked: true });
      return;
    }

    const data = result.data;
    if (data && typeof data.username === 'string' && typeof data.displayName === 'string') {
      set({ authUser: data, sessionChecked: true });
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
  },
}));
