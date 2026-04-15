import type { StateConfig } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { ProjectCard } from './ProjectCard';
import styles from './KanbanColumn.module.css';

interface KanbanColumnProps {
  config: StateConfig;
  projects: Project[];
  collapsed?: boolean;
  onToggleExpand?: () => void;
}

const typeClassMap: Record<string, string> = {
  action: styles.columnAction,
  buffer: styles.columnBuffer,
  active: styles.columnActive,
  done: styles.columnDone,
};

export function KanbanColumn({ config, projects, collapsed, onToggleExpand }: KanbanColumnProps) {
  if (collapsed) {
    return (
      <div
        className={`${styles.column} ${typeClassMap[config.type] ?? ''} ${styles.columnCollapsed}`}
        data-testid={`kanban-column-${config.key}`}
        onClick={onToggleExpand}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onToggleExpand?.();
        }}
      >
        <div className={styles.collapsedHeader} style={{ borderColor: config.color }}>
          <span className={styles.collapsedLabel}>{config.label}</span>
          <span className={styles.collapsedCount} data-testid={`column-count-${config.key}`}>
            {projects.length}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.column} ${typeClassMap[config.type] ?? ''}`}
      data-testid={`kanban-column-${config.key}`}
    >
      <div
        className={styles.header}
        style={{ borderBottomColor: config.color }}
        data-testid={`column-header-${config.key}`}
        onClick={onToggleExpand}
        role={onToggleExpand ? 'button' : undefined}
        tabIndex={onToggleExpand ? 0 : undefined}
        onKeyDown={
          onToggleExpand
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') onToggleExpand();
              }
            : undefined
        }
      >
        <span className={styles.label}>
          {config.label} (<span data-testid={`column-count-${config.key}`}>{projects.length}</span>)
        </span>
        {onToggleExpand && (
          <span className={styles.collapseChevron} aria-hidden="true">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 6 9 12 15 18" />
            </svg>
          </span>
        )}
      </div>
      <div className={styles.cards}>
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    </div>
  );
}
