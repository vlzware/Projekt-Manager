import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  eachWeekOfInterval,
  isSameMonth,
  isToday,
  format,
  parseISO,
  isSameDay,
} from 'date-fns';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { ProjectBar } from './ProjectBar';
import styles from './CalendarGrid.module.css';

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

interface CalendarGridProps {
  month: Date;
  projects: Project[];
}

export function CalendarGrid({ month, projects }: CalendarGridProps) {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const weeks = eachWeekOfInterval(
    { start: calendarStart, end: calendarEnd },
    { weekStartsOn: 1 }
  );

  // Build project placement per week
  const getProjectsForWeek = (weekStart: Date) => {
    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
    const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd });

    return projects
      .filter((p) => {
        if (!p.plannedStart) return false;
        const pStart = parseISO(p.plannedStart);
        const pEnd = p.plannedEnd ? parseISO(p.plannedEnd) : pStart;
        // Project overlaps with this week
        return pStart <= weekEnd && pEnd >= weekStart;
      })
      .map((p) => {
        const pStart = parseISO(p.plannedStart!);
        const pEnd = p.plannedEnd ? parseISO(p.plannedEnd) : pStart;
        const startCol = Math.max(
          0,
          weekDays.findIndex((d) => isSameDay(d, pStart) || d > pStart) === -1
            ? 0
            : weekDays.findIndex((d) => isSameDay(d, pStart) || d >= pStart)
        );
        let endCol = weekDays.findIndex((d) => isSameDay(d, pEnd) || d > pEnd);
        if (endCol === -1) endCol = 6;
        else if (!isSameDay(weekDays[endCol], pEnd) && weekDays[endCol] > pEnd) endCol--;
        if (endCol < startCol) endCol = startCol;

        // Handle case where project starts before this week
        const effectiveStartCol = pStart < weekStart ? 0 : startCol;
        // Handle case where project ends after this week
        const effectiveEndCol = pEnd > weekEnd ? 6 : endCol;

        return {
          project: p,
          startCol: effectiveStartCol,
          endCol: effectiveEndCol,
          color: STATE_CONFIG_MAP[p.status].color,
        };
      });
  };

  return (
    <div className={styles.grid} data-testid="calendar-grid">
      <div className={styles.headerRow}>
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className={styles.headerCell}>
            {label}
          </div>
        ))}
      </div>
      <div className={styles.body}>
        {weeks.map((weekStart) => {
          const days = eachDayOfInterval({
            start: weekStart,
            end: endOfWeek(weekStart, { weekStartsOn: 1 }),
          });
          const weekProjects = getProjectsForWeek(weekStart);

          return (
            <div key={weekStart.toISOString()} className={styles.weekRow}>
              {days.map((day) => {
                const sameMonth = isSameMonth(day, month);
                const todayFlag = isToday(day);

                return (
                  <div
                    key={day.toISOString()}
                    className={`${styles.dayCell} ${!sameMonth ? styles.otherMonth : ''} ${todayFlag ? styles.today : ''}`}
                    data-testid={`calendar-day-${format(day, 'yyyy-MM-dd')}`}
                  >
                    <div className={styles.dayNumber}>
                      <span className={todayFlag ? styles.todayNumber : ''}>
                        {format(day, 'd')}
                      </span>
                    </div>
                  </div>
                );
              })}
              {/* Render project bars as overlay */}
              {weekProjects.map((wp, idx) => (
                <ProjectBar
                  key={`${wp.project.id}-${weekStart.toISOString()}`}
                  project={wp.project}
                  startCol={wp.startCol}
                  endCol={wp.endCol}
                  color={wp.color}
                  rowIndex={idx}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
