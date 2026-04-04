import type { StateConfig } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { ProjectCard } from './ProjectCard';
import styles from './KanbanColumn.module.css';

interface KanbanColumnProps {
  config: StateConfig;
  projects: Project[];
}

const typeClassMap: Record<string, string> = {
  action: styles.columnAction,
  buffer: styles.columnBuffer,
  active: styles.columnActive,
  done: styles.columnDone,
};

export function KanbanColumn({ config, projects }: KanbanColumnProps) {
  return (
    <div
      className={`${styles.column} ${typeClassMap[config.type] ?? ''}`}
      data-testid={`kanban-column-${config.key}`}
    >
      <div className={styles.header} style={{ borderBottomColor: config.color }}>
        <span className={styles.label}>{config.label}</span>
        <span className={styles.count} data-testid={`column-count-${config.key}`}>
          {projects.length}
        </span>
      </div>
      <div className={styles.cards}>
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    </div>
  );
}
