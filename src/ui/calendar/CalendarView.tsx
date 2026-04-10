import { useState } from 'react';
import { addMonths, subMonths, format } from 'date-fns';
import { LOCALE } from '@/config/localeConfig';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { useRouterNav } from '@/hooks/useRouterNav';
import { CalendarGrid } from './CalendarGrid';
import styles from './CalendarView.module.css';

export function CalendarView() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const projects = useProjectStore((s) => s.projects);
  const activeFilter = useUIStore((s) => s.activeFilter);
  const getSummary = useProjectStore((s) => s.getSummary);
  const { navigateTo } = useRouterNav();

  const summary = getSummary();
  const monthLabel = format(currentMonth, 'MMMM yyyy', { locale: LOCALE.dateFns });

  const filteredProjects = activeFilter
    ? projects.filter((p) => p.status === activeFilter)
    : projects;

  // Only show projects with at least plannedStart
  const calendarProjects = filteredProjects.filter((p) => p.plannedStart);

  const setFilterNoDates = useUIStore((s) => s.setFilterNoDates);

  const handleNoDatesClick = () => {
    // Switch to kanban and apply the "no dates" filter so only projects
    // missing both planned dates are visible. Order matters: navigateTo
    // calls setView which clears filters, so the filter must be set AFTER
    // the navigation. The filter is mutually exclusive with the
    // workflow-state filter (see uiStore).
    navigateTo('/kanban');
    setFilterNoDates(true);
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
