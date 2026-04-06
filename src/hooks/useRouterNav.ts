/**
 * Safe navigation hook — works with and without a React Router context.
 *
 * In production the app is wrapped in BrowserRouter (main.tsx) so useNavigate
 * and useLocation are available. In unit tests that render <App /> directly
 * (no router), the hook falls back to the Zustand UI store.
 *
 * Path ↔ ViewMode mapping:
 *   /kanban   → 'kanban'
 *   /calendar → 'kalender'
 */

import { useInRouterContext, useNavigate, useLocation } from 'react-router-dom';
import { useUIStore } from '@/state/uiStore';
import type { ViewMode } from '@/domain/types';

const PATH_TO_VIEW: Record<string, ViewMode> = {
  '/kanban': 'kanban',
  '/calendar': 'kalender',
};

const VIEW_TO_PATH: Record<ViewMode, string> = {
  kanban: '/kanban',
  kalender: '/calendar',
};

export function viewFromPath(pathname: string): ViewMode {
  return PATH_TO_VIEW[pathname] ?? 'kanban';
}

export function pathFromView(view: ViewMode): string {
  return VIEW_TO_PATH[view];
}

/**
 * Hook that navigates via React Router when available, or falls back
 * to the Zustand UI store when rendered without a router (unit tests).
 *
 * The eslint-disable below is safe: useInRouterContext() returns a
 * constant per mount — a component is either inside a <BrowserRouter>
 * or not for its entire lifetime, so the hook call order never changes.
 */
export function useRouterNav() {
  const hasRouter = useInRouterContext();

  if (hasRouter) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useRouterNavWithRouter();
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useRouterNavWithStore();
}

/** Router path — only called when a BrowserRouter context is present. */
function useRouterNavWithRouter() {
  const navigate = useNavigate();
  const location = useLocation();
  const setView = useUIStore((s) => s.setView);

  return {
    navigateTo: (path: string) => {
      navigate(path);
      // Also sync the store so components reading activeView stay correct
      // before the URL→store sync effect fires.
      setView(viewFromPath(path));
    },
    pathname: location.pathname,
  };
}

/** Store-only path — used in tests that render without a router. */
function useRouterNavWithStore() {
  const setView = useUIStore((s) => s.setView);
  const activeView = useUIStore((s) => s.activeView);

  return {
    navigateTo: (path: string) => {
      setView(viewFromPath(path));
    },
    pathname: pathFromView(activeView),
  };
}
