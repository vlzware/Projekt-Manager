import { useState } from 'react';
import { addMonths, subMonths, format } from 'date-fns';
import { de } from 'date-fns/locale';
import { useProjectStore } from '@/state/store';
import { CalendarGrid } from './CalendarGrid';
import styles from './CalendarView.module.css';

export function CalendarView() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const projects = useProjectStore((s) => s.projects);
  const activeFilter = useProjectStore((s) => s.activeFilter);
  const setView = useProjectStore((s) => s.setView);
  const setFilter = useProjectStore((s) => s.setFilter);
  const getSummary = useProjectStore((s) => s.getSummary);

  const summary = getSummary();
  const monthLabel = format(currentMonth, 'MMMM yyyy', { locale: de });

  const filteredProjects = activeFilter
    ? projects.filter((p) => p.status === activeFilter)
    : projects;

  // Only show projects with at least plannedStart
  const calendarProjects = filteredProjects.filter((p) => p.plannedStart);

  const handleNoDatesClick = () => {
    // Switch to kanban and filter to show projects without dates
    // Since we can't filter by "no dates" directly, just switch to kanban
    setView('kanban');
    setFilter(null);
  };

  return (
    <div className={styles.container} data-testid="calendar-view">
      <div className={styles.navigation}>
        <button
          className={styles.navButton}
          onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
          data-testid="calendar-prev"
        >
          &larr;
        </button>
        <span className={styles.monthLabel} data-testid="calendar-month-label">
          {monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1)}
        </span>
        <button
          className={styles.navButton}
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          data-testid="calendar-next"
        >
          &rarr;
        </button>
      </div>
      <CalendarGrid month={currentMonth} projects={calendarProjects} />
      {summary.projectsWithoutDates > 0 && (
        <div
          className={styles.noDatesCounter}
          onClick={handleNoDatesClick}
          data-testid="no-dates-counter"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') handleNoDatesClick();
          }}
        >
          {summary.projectsWithoutDates} Projekte ohne Termin
        </div>
      )}
    </div>
  );
}
