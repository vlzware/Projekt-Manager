/**
 * Barrel export — re-exports from the split stores.
 *
 * Components should import directly from authStore, projectStore, or uiStore.
 *
 * The former `clearStoresOnLogout` helper was removed in iteration 5 —
 * authStore.logout() and authStore.handleSessionExpired() now own the
 * downstream-reset logic so the interactive and session-expired paths
 * cannot diverge (consolidation review C F-6).
 */

export { useAuthStore } from './authStore';
export { useProjectStore } from './projectStore';
export { useUIStore } from './uiStore';
