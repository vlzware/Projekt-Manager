/**
 * Cross-cutting subscription that refreshes both project stores on every
 * `project_changed` SSE frame (api.md §14.2.13, ADR-0025).
 *
 * Why a dedicated module rather than a `subscribe()` on one of the
 * project stores:
 *   - The handler must drive BOTH `useProjectStore` (kanban / calendar /
 *     detail) and `useProjectManagementStore` (management list). A
 *     `subscribe()` on either store would force the other to know about
 *     it, leaking the SSE concern across both slices.
 *   - The channel must be live regardless of which surface is currently
 *     mounted — an always-open observer parked on /projekte is one
 *     scenario; a worker on /kanban is another. A single bootstrap-time
 *     subscription beats a per-surface refcount when the lifetime is
 *     "the whole page".
 *
 * Idempotency: the module guards against double-registration so a hot
 * reload (or a stray second bootstrap) does not produce double refetches
 * per event. The first call attaches the handler; subsequent calls
 * return the same unsubscribe handle.
 */

import { useProjectStore } from './projectStore';
import { useProjectManagementStore } from './projectManagementStore';
import { PROJECT_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';

let unsubscribe: (() => void) | null = null;

export function subscribeProjectStoresToSse(): () => void {
  if (unsubscribe) return unsubscribe;

  const off = onSseEvent(PROJECT_CHANGED, () => {
    void useProjectStore.getState().fetchProjects();
    void useProjectManagementStore.getState().fetchProjects();
  });

  unsubscribe = () => {
    off();
    unsubscribe = null;
  };
  return unsubscribe;
}

/** Test-only: tear down the singleton so each test starts clean. */
export function __resetProjectSseSubscriptionForTests(): void {
  if (unsubscribe) {
    unsubscribe();
  }
  unsubscribe = null;
}
