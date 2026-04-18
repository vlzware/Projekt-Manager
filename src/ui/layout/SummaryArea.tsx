import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { useRouterNav, pathFromView } from '@/hooks/useRouterNav';
import { routeByView } from '@/config/routes';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { STRINGS } from '@/config/strings';
import type { WorkflowState } from '@/config/stateConfig';
import styles from './SummaryArea.module.css';

export function SummaryArea() {
  const projects = useProjectStore((s) => s.projects);
  const activeFilter = useUIStore((s) => s.activeFilter);
  const filterNoDates = useUIStore((s) => s.filterNoDates);
  const setFilter = useUIStore((s) => s.setFilter);
  const clearFilters = useUIStore((s) => s.clearFilters);
  const getSummary = useProjectStore((s) => s.getSummary);
  const authUser = useAuthStore((s) => s.authUser);
  const { navigateTo } = useRouterNav();

  const summary = getSummary();
  const anyFilterActive = activeFilter !== null || filterNoDates;
  const canJumpToKanban = !!authUser && routeByView('kanban').canAccess(authUser);

  const filterAgedOnly = useUIStore((s) => s.filterAgedOnly);

  const handleFilterClick = (state: WorkflowState, agedOnly = false) => {
    const isSameFilter = activeFilter === state && filterAgedOnly === agedOnly;
    if (isSameFilter) {
      // Toggle off the active filter — stay on the current view.
      setFilter(null, false);
      return;
    }
    // Activating a filter always brings the user to the Kanban view, where
    // the filter is most legible. Order matters: navigateTo calls setView
    // which clears filters as a side effect (see uiStore), so the filter
    // must be set AFTER the navigation. Same pattern as
    // CalendarView.handleNoDatesClick.
    navigateTo(pathFromView('kanban'));
    setFilter(state, agedOnly);
  };

  // Filter out action states with zero projects
  const actionEntries = Object.entries(summary.actionCounts).filter(
    ([, count]) => (count ?? 0) > 0,
  ) as [WorkflowState, number][];

  return (
    <div className={styles.summary} data-testid="summary-area">
      {canJumpToKanban &&
        actionEntries.map(([state, count]) => (
          <button
            key={state}
            className={`${styles.indicator} ${activeFilter === state ? styles.activeIndicator : ''}`}
            onClick={() => handleFilterClick(state)}
            data-testid={`summary-action-${state}`}
          >
            {count}&times; {STATE_CONFIG_MAP[state].label}
          </button>
        ))}
      {canJumpToKanban &&
        summary.agedBufferCounts.map(({ state, count, thresholdDays }) => (
          <button
            key={state}
            className={`${styles.indicator} ${styles.agedIndicator} ${activeFilter === state && filterAgedOnly ? styles.activeIndicator : ''}`}
            onClick={() => handleFilterClick(state, true)}
            data-testid={`summary-buffer-${state}`}
          >
            {STRINGS.aging.agedBuffer(count, STATE_CONFIG_MAP[state].label, thresholdDays)}
          </button>
        ))}
      {anyFilterActive && (
        <button className={styles.clearButton} onClick={clearFilters} data-testid="clear-filter">
          {STRINGS.ui.clearFilter}
        </button>
      )}
      {/* Hidden project count for calendar without-dates counter logic */}
      <span data-testid="summary-projects-count" style={{ display: 'none' }}>
        {projects.length}
      </span>
    </div>
  );
}
