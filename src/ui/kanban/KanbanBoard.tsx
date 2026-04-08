import { useState, useCallback } from 'react';
import { STATE_CONFIGS } from '@/config/stateConfig';
import type { WorkflowState } from '@/config/stateConfig';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { useCollapseTier } from './useCollapseTier';
import { KanbanColumn } from './KanbanColumn';
import styles from './KanbanBoard.module.css';

export function KanbanBoard() {
  const projects = useProjectStore((s) => s.projects);
  const activeFilter = useUIStore((s) => s.activeFilter);
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

  // Filters are mutually exclusive (see uiStore). Apply whichever is active.
  const filteredProjects = filterNoDates
    ? projects.filter((p) => !p.plannedStart && !p.plannedEnd)
    : activeFilter
      ? projects.filter((p) => p.status === activeFilter)
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
