import { useProjectStore } from '@/state/store';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import type { WorkflowState } from '@/config/stateConfig';
import styles from './SummaryArea.module.css';

export function SummaryArea() {
  const projects = useProjectStore((s) => s.projects);
  const activeFilter = useProjectStore((s) => s.activeFilter);
  const setFilter = useProjectStore((s) => s.setFilter);
  const getSummary = useProjectStore((s) => s.getSummary);

  const summary = getSummary();

  const handleFilterClick = (state: WorkflowState) => {
    setFilter(activeFilter === state ? null : state);
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
          className={`${styles.indicator} ${styles.actionIndicator}`}
          onClick={() => handleFilterClick(state)}
          data-testid={`summary-action-${state}`}
          style={{
            borderColor: activeFilter === state ? STATE_CONFIG_MAP[state].color : undefined,
          }}
        >
          {count}&times; {STATE_CONFIG_MAP[state].label}
        </button>
      ))}
      {summary.agedBufferCounts.map(({ state, count, thresholdDays }) => (
        <button
          key={state}
          className={`${styles.indicator} ${styles.bufferIndicator}`}
          onClick={() => handleFilterClick(state)}
          data-testid={`summary-buffer-${state}`}
          style={{
            borderColor: activeFilter === state ? STATE_CONFIG_MAP[state].color : undefined,
          }}
        >
          {count} {STATE_CONFIG_MAP[state].label} seit &gt;{thresholdDays} Tagen
        </button>
      ))}
      {activeFilter && (
        <button
          className={styles.clearButton}
          onClick={() => setFilter(null)}
          data-testid="clear-filter"
        >
          Filter aufheben
        </button>
      )}
      {/* Hidden project count for calendar without-dates counter logic */}
      <span data-testid="summary-projects-count" style={{ display: 'none' }}>
        {projects.length}
      </span>
    </div>
  );
}
