import { useState, useCallback } from 'react';
import { STATE_CONFIGS } from '@/config/stateConfig';
import type { WorkflowState } from '@/config/stateConfig';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { isBufferAged } from '@/domain/aging';
import { useCollapseTier } from './useCollapseTier';
import { KanbanColumn } from './KanbanColumn';
import styles from './KanbanBoard.module.css';

export function KanbanBoard() {
  const projects = useProjectStore((s) => s.projects);
  const activeFilter = useUIStore((s) => s.activeFilter);
  const filterAgedOnly = useUIStore((s) => s.filterAgedOnly);
  const filterNoDates = useUIStore((s) => s.filterNoDates);
  const activeTier = useCollapseTier();
  // Per-column override of the auto-collapse tier. `true` = forced collapsed,
  // `false` = forced expanded, absent = follow the tier.
  const [userOverride, setUserOverride] = useState<Map<WorkflowState, boolean>>(new Map());

  const toggleCollapsed = useCallback((key: WorkflowState, currentlyCollapsed: boolean) => {
    setUserOverride((prev) => {
      const next = new Map(prev);
      next.set(key, !currentlyCollapsed);
      return next;
    });
  }, []);

  // When a filter badge is clicked, force the matching column expanded and
  // all others collapsed — draws attention to the relevant column.
  // When cleared, drop all overrides so auto-collapse tiers take over again.
  // Uses "adjust state during render" (React docs) instead of useEffect
  // to avoid cascading renders.
  const [prevFilter, setPrevFilter] = useState(activeFilter);
  if (prevFilter !== activeFilter) {
    setPrevFilter(activeFilter);
    if (activeFilter) {
      const forced = new Map<WorkflowState, boolean>();
      for (const c of STATE_CONFIGS) forced.set(c.key, c.key !== activeFilter);
      setUserOverride(forced);
    } else {
      setUserOverride(new Map());
    }
  }

  // Filters are mutually exclusive (see uiStore). Apply whichever is active.
  const filteredProjects = filterNoDates
    ? projects.filter((p) => !p.plannedStart && !p.plannedEnd)
    : activeFilter
      ? projects.filter(
          (p) =>
            p.status === activeFilter &&
            (!filterAgedOnly || isBufferAged(p.status, p.statusChangedAt)),
        )
      : projects;

  return (
    <div className={styles.board} data-testid="kanban-board">
      {STATE_CONFIGS.map((config) => {
        const columnProjects = filteredProjects
          .filter((p) => p.status === config.key)
          .sort(
            (a, b) => new Date(a.statusChangedAt).getTime() - new Date(b.statusChangedAt).getTime(),
          );

        const autoCollapsed = activeTier > 0 && config.collapseTier >= activeTier;
        const override = userOverride.get(config.key);
        const collapsed = override ?? autoCollapsed;

        return (
          <KanbanColumn
            key={config.key}
            config={config}
            projects={columnProjects}
            collapsed={collapsed}
            onToggleExpand={() => toggleCollapsed(config.key, collapsed)}
          />
        );
      })}
    </div>
  );
}
