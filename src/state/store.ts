/**
 * Barrel export — re-exports from the split stores.
 *
 * Components should import directly from authStore, projectStore, or uiStore.
 * This file also provides cross-store helpers (e.g. clearStoresOnLogout).
 */

export { useAuthStore } from './authStore';
export { useProjectStore } from './projectStore';
export { useUIStore } from './uiStore';

import { useProjectStore } from './projectStore';
import { useUIStore } from './uiStore';

/** Reset project and UI stores after logout. */
export function clearStoresOnLogout() {
  useProjectStore.setState({ projects: [], mutationInFlight: {}, mutationError: null });
  useUIStore.setState({ selectedProjectId: null, activeFilter: null, activeView: 'kanban' });
}
