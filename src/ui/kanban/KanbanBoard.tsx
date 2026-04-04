import { STATE_CONFIGS } from '@/config/stateConfig';
import { useProjectStore } from '@/state/store';
import { KanbanColumn } from './KanbanColumn';
import styles from './KanbanBoard.module.css';

export function KanbanBoard() {
  const projects = useProjectStore((s) => s.projects);
  const activeFilter = useProjectStore((s) => s.activeFilter);

  const filteredProjects = activeFilter
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

        return <KanbanColumn key={config.key} config={config} projects={columnProjects} />;
      })}
    </div>
  );
}
