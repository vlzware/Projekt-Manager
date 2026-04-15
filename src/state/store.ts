/**
 * Barrel export — re-exports from the split stores.
 *
 * Components should import directly from authStore, projectStore, or uiStore.
 */

export { useAuthStore } from './authStore';
export { useProjectStore } from './projectStore';
export { useUIStore } from './uiStore';
