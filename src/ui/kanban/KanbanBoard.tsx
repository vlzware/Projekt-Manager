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
  const [expanded, setExpanded] = useState<Set<WorkflowState>>(new Set());

  const toggleExpand = useCallback((key: WorkflowState) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // When a filter badge is clicked, expand only the matching column and
  // collapse all others — draws attention to the relevant column.
  // When cleared, reset so auto-collapse tiers take over again.
  // Uses "adjust state during render" (React docs) instead of useEffect
  // to avoid cascading renders.
  const [prevFilter, setPrevFilter] = useState(activeFilter);
  if (prevFilter !== activeFilter) {
    setPrevFilter(activeFilter);
    setExpanded(activeFilter ? new Set([activeFilter]) : new Set());
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
        const collapsed = autoCollapsed && !expanded.has(config.key);

        return (
          <KanbanColumn
            key={config.key}
            config={config}
            projects={columnProjects}
            collapsed={collapsed}
            onToggleExpand={() => toggleExpand(config.key)}
          />
        );
      })}
    </div>
  );
}
