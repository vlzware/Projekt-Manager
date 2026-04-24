/**
 * Returns a click handler that opens a project — modal preview on
 * desktop, direct navigation to the detail page on narrow viewports.
 *
 * The desktop preview modal is a fast-glance surface; on a phone the
 * modal collapses awkwardly and adds an extra ceremony tap before the
 * worker can act on the project. Below the `md` breakpoint we skip the
 * modal entirely and deep-link to `/projects/:id`, which is the
 * worker's primary mobile surface anyway.
 */
import { useUIStore } from '@/state/uiStore';
import { useRouterNav } from '@/hooks/useRouterNav';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { BREAKPOINTS } from '@/config/breakpoints';

export function useOpenProject(): (projectId: string) => void {
  const selectProject = useUIStore((s) => s.selectProject);
  const { navigateTo } = useRouterNav();
  const isNarrow = useMediaQuery(`(max-width: ${BREAKPOINTS.md}px)`);

  return (projectId: string) => {
    if (isNarrow) {
      navigateTo(`/projects/${projectId}`);
      return;
    }
    selectProject(projectId);
  };
}
