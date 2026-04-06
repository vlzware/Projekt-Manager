import type { Project } from '@/domain/types';
import { useUIStore } from '@/state/uiStore';
import styles from './ProjectBar.module.css';

interface ProjectBarProps {
  project: Project;
  startCol: number;
  endCol: number;
  color: string;
  rowIndex: number;
}

export function ProjectBar({ project, startCol, endCol, color, rowIndex }: ProjectBarProps) {
  const selectProject = useUIStore((s) => s.selectProject);
  const colWidth = 100 / 7;
  const left = `${startCol * colWidth}%`;
  const width = `${(endCol - startCol + 1) * colWidth}%`;
  const top = `${24 + rowIndex * 22}px`;

  const handleClick = () => {
    selectProject(project.id);
  };

  return (
    <div
      className={styles.bar}
      style={{
        backgroundColor: color,
        left,
        width,
        top,
      }}
      onClick={handleClick}
      data-testid={`calendar-bar-${project.id}`}
      title={`${project.number} – ${project.title}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleClick();
      }}
    >
      {project.number} {project.title}
    </div>
  );
}
