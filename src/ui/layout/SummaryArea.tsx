import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
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

  const summary = getSummary();
  const anyFilterActive = activeFilter !== null || filterNoDates;

  const filterAgedOnly = useUIStore((s) => s.filterAgedOnly);

  const handleFilterClick = (state: WorkflowState, agedOnly = false) => {
    const isSameFilter = activeFilter === state && filterAgedOnly === agedOnly;
    setFilter(isSameFilter ? null : state, isSameFilter ? false : agedOnly);
  };

  // Filter out action states with zero projects
  const actionEntries = Object.entries(summary.actionCounts).filter(
    ([, count]) => (count ?? 0) > 0,
  ) as [WorkflowState, number][];

  return (
    <div className={styles.summary} data-testid="summary-area">
      {actionEntries.map(([state, count]) => (
        <button
          key={state}
          className={`${styles.indicator} ${activeFilter === state ? styles.activeIndicator : ''}`}
          onClick={() => handleFilterClick(state)}
          data-testid={`summary-action-${state}`}
        >
          {count}&times; {STATE_CONFIG_MAP[state].label}
        </button>
      ))}
      {summary.agedBufferCounts.map(({ state, count, thresholdDays }) => (
        <button
          key={state}
          className={`${styles.indicator} ${styles.agedIndicator} ${activeFilter === state && filterAgedOnly ? styles.activeIndicator : ''}`}
          onClick={() => handleFilterClick(state, true)}
          data-testid={`summary-buffer-${state}`}
        >
          {count} {STATE_CONFIG_MAP[state].label} seit &gt;{thresholdDays} Tagen
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
