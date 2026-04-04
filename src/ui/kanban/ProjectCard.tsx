import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { formatDateRange, formatDateDE } from '@/domain/dateFormat';
import { isAgingBold, getAgingText } from '@/domain/aging';
import { canTransitionForward, getNextState } from '@/domain/transitions';
import { useProjectStore } from '@/state/store';
import styles from './ProjectCard.module.css';

interface ProjectCardProps {
  project: Project;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const transitionForward = useProjectStore((s) => s.transitionForward);
  const selectProject = useProjectStore((s) => s.selectProject);
  const config = STATE_CONFIG_MAP[project.status];
  const bold = isAgingBold(project.status, project.statusChangedAt);
  const agingText = getAgingText(project.status, project.statusChangedAt);
  const dateRange = formatDateRange(project.plannedStart, project.plannedEnd);
  const entryDate = formatDateDE(project.statusChangedAt);
  const showForward = canTransitionForward(project.status);

  const handleCardClick = () => {
    selectProject(project.id);
  };

  const handleForwardClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = getNextState(project.status);
    if (!next) return;
    const nextLabel = STATE_CONFIG_MAP[next].label;
    const confirmed = window.confirm(`Status ändern: ${config.label} → ${nextLabel}?`);
    if (confirmed) {
      transitionForward(project.id);
    }
  };

  return (
    <div
      className={styles.card}
      onClick={handleCardClick}
      data-testid={`project-card-${project.id}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleCardClick();
      }}
    >
      <div className={styles.topRow}>
        <span className={styles.dot} style={{ backgroundColor: config.color }} />
        <span className={styles.projectNumber}>{project.number}</span>
      </div>
      <div className={styles.title}>{project.title}</div>
      <div className={styles.customer}>{project.customer.name}</div>
      <div
        className={dateRange === 'Kein Termin' ? styles.noDates : styles.dates}
        data-testid={`card-dates-${project.id}`}
      >
        {dateRange}
      </div>
      <div
        className={`${styles.entryDate} ${bold ? styles.entryDateBold : ''}`}
        data-testid={`entry-date-${project.id}`}
      >
        seit {entryDate}
      </div>
      <div className={styles.bottomRow}>
        {agingText ? (
          <span className={styles.agingText} data-testid={`aging-text-${project.id}`}>
            {agingText}
          </span>
        ) : <span />}
        {showForward && (
          <button
            className={styles.forwardButton}
            onClick={handleForwardClick}
            data-testid={`forward-button-${project.id}`}
            aria-label={`Status weiter: ${config.label}`}
          >
            &rarr;
          </button>
        )}
      </div>
    </div>
  );
}
