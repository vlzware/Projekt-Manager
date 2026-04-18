/**
 * Authentication state — login, logout, session management.
 *
 * Separated from project and UI state so auth concerns don't
 * pollute other stores, and so the login flow can be tested independently.
 */

import { create } from 'zustand';
import { authApi, type AuthUser } from '@/api/client';
import { STRINGS } from '@/config/strings';
import { THEME_PREFERENCE_KEY, type ThemePreference } from '@/config/themeStorage';
import { applyThemePreference } from '@/styles/themeRuntime';
import type { BackupStatus } from '@/domain/backupBadge';
import { useProjectStore } from './projectStore';
import { useUIStore } from './uiStore';
import { useCustomerStore } from './customerStore';
import { useUserStore } from './userStore';
import { useProjectManagementStore } from './projectManagementStore';
import { useDataExchangeStore } from './dataExchangeStore';

interface AuthState {
  authUser: AuthUser | null;
  authError: string | null;
  sessionChecked: boolean;
  /**
   * Backup-freshness status attached to the authenticated session. The
   * server only includes this for callers with role `owner`
   * (verification.md AC-170). `undefined` means either "not an owner"
   * or "status source unreachable"; the badge component treats the
   * latter as the "Status unbekannt" branch and non-owner UI never
   * reads this field.
   */
  backupStatus: BackupStatus | undefined;

  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  handleSessionExpired: () => void;
  updateThemePreference: (value: ThemePreference) => Promise<void>;
}

/**
 * Write the theme preference to localStorage. Extracted so the optimistic
 * update and the revert path stay symmetric — both need to tolerate the
 * occasional localStorage throw (private-browsing, sandboxed contexts).
 */
function writeCachedPreference(value: ThemePreference | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) {
      window.localStorage.removeItem(THEME_PREFERENCE_KEY);
    } else {
      window.localStorage.setItem(THEME_PREFERENCE_KEY, value);
    }
  } catch {
    // Swallow — the in-memory state still reflects the user's choice; a
    // cache failure only costs a flash on next reload.
  }
}

function readCachedPreference(): ThemePreference | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Same rationale as above.
  }
  return null;
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
  useDataExchangeStore.setState({
    file: null,
    envelope: null,
    preview: null,
    previewError: null,
    phraseInput: '',
    importing: false,
    importResult: null,
    importError: null,
    exporting: false,
    exportError: null,
  });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  authUser: null,
  authError: null,
  sessionChecked: false,
  backupStatus: undefined,

  login: async (username: string, password: string) => {
    set({ authError: null });

    const result = await authApi.login(username, password);

    if (!result.ok) {
      set({ authError: result.error.message || STRINGS.auth.loginFailed });
      return;
    }

    // Spec §9.6: after the authenticated session is established, the
    // client replaces the local cache with the server value and re-applies
    // the theme. Login is one of the two session-establishment paths
    // (checkSession is the other) so the same hydration rule applies.
    writeCachedPreference(result.data.user.themePreference);
    applyThemePreference(result.data.user.themePreference);

    set({
      authUser: result.data.user,
      authError: null,
      // `backupStatus` is only included by the server for owner callers
      // (verification.md AC-170). The envelope is typed as optional, so
      // a missing field lands here as `undefined` and the badge
      // component stays hidden for non-owners without a second branch.
      backupStatus: result.data.backupStatus,
    });
  },

  logout: async () => {
    await authApi.logout();
    set({
      authUser: null,
      authError: null,
      backupStatus: undefined,
    });
    clearDownstreamState();
  },

  checkSession: async () => {
    const result = await authApi.me();

    if (!result.ok) {
      set({ authUser: null, sessionChecked: true, backupStatus: undefined });
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
      // Spec §9.6 / AC-120: the server value is authoritative. On
      // hydration, overwrite any stale localStorage cache and re-apply
      // the scheme so a cache mismatch does not survive the round-trip.
      if (
        user.themePreference === 'light' ||
        user.themePreference === 'dark' ||
        user.themePreference === 'system'
      ) {
        writeCachedPreference(user.themePreference);
        applyThemePreference(user.themePreference);
      }
      set({ authUser: user, sessionChecked: true, backupStatus: result.data.backupStatus });
    } else {
      set({ sessionChecked: true });
    }
  },

  handleSessionExpired: () => {
    set({
      authUser: null,
      authError: STRINGS.auth.sessionExpiredLogin,
      sessionChecked: true,
      backupStatus: undefined,
    });
    clearDownstreamState();
  },

  /**
   * Self-update the user's color-scheme preference.
   *
   * Spec §9.6: applied optimistically, reconciled with the server response,
   * reverted on failure. The UI must flip before the round-trip completes
   * (AC-119). The optimistic leg updates:
   *   1. The in-memory `authUser.themePreference`,
   *   2. The localStorage cache (so a reload without a new session
   *      hydration still paints the chosen scheme via the pre-paint
   *      script in public/theme-init.js),
   *   3. The document root via `applyThemePreference`.
   *
   * On success the server-returned user replaces the optimistic one. On
   * failure all three of the above are reverted to the pre-click state,
   * and the error is surfaced via the projectStore mutation-error banner
   * (spec §9.5) — the same mechanism other failed mutations use.
   */
  updateThemePreference: async (value: ThemePreference) => {
    const previousUser = get().authUser;
    if (!previousUser) return;
    const previousPreference = previousUser.themePreference;
    if (previousPreference === value) return;
    const previousCache = readCachedPreference();

    // --- Optimistic leg ----------------------------------------------------
    set({ authUser: { ...previousUser, themePreference: value } });
    writeCachedPreference(value);
    applyThemePreference(value);

    const result = await authApi.updateSelf({ themePreference: value });

    if (!result.ok) {
      // Revert the optimistic local state FIRST so the login screen
      // (or whichever view the user lands on) reflects the last
      // server-authoritative value, not a theme the server never
      // accepted. This applies to both the session-expired and the
      // generic-error branches.
      set({ authUser: { ...previousUser, themePreference: previousPreference } });
      writeCachedPreference(previousCache);
      applyThemePreference(previousPreference);

      if (result.sessionExpired) {
        get().handleSessionExpired();
        return;
      }
      // Surface the server-supplied message (or the canonical German
      // fallback for empty-message paths). Reuses the projectStore
      // mutation-error banner so the feedback surface stays consistent
      // with spec §9.5.
      useProjectStore.setState({
        mutationError: result.error.message || STRINGS.errors.mutationFailed,
      });
      return;
    }

    // --- Reconcile with server response -----------------------------------
    // Replace the optimistic user with the server-returned profile so any
    // other server-authoritative fields on the projection stay in sync.
    // Defensive shape check matches checkSession above.
    const serverUser = result.data?.user;
    if (
      serverUser &&
      typeof serverUser.username === 'string' &&
      typeof serverUser.displayName === 'string'
    ) {
      set({ authUser: serverUser });
      writeCachedPreference(serverUser.themePreference);
      applyThemePreference(serverUser.themePreference);
    }
  },
}));

/**
 * Standalone password-change action. Does not affect auth state (the session
 * stays valid), so it lives outside the store. UI components can import this
 * instead of reaching for @/api/client directly.
 */
export async function changePassword(currentPassword: string, newPassword: string) {
  const result = await authApi.changePassword(currentPassword, newPassword);
  if (!result.ok && result.sessionExpired) {
    useAuthStore.getState().handleSessionExpired();
  }
  return result;
}
