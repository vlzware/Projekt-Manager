import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { mockProjects } from '@/test/fixtures/mockProjects';
import { installFailingFetch, mockFetchJson, type FetchSpy } from '@/test/fetchMock';
import { App } from '@/App';

// Tests that trigger mutations must configure fetchSpy explicitly. See the
// src/ui/__tests__/auth.test.tsx pattern and the src/test/setup.ts comment.
let fetchSpy: FetchSpy;

beforeEach(() => {
  fetchSpy = installFailingFetch();
  useAuthStore.setState({
    ...useAuthStore.getInitialState(),
    authUser: {
      id: 'u1',
      username: 'mock',
      displayName: 'Mock User',
      roles: ['owner'],
      email: null,
    },
  });
  useProjectStore.setState({
    ...useProjectStore.getInitialState(),
    projects: [...mockProjects],
  });
  useUIStore.setState({ ...useUIStore.getInitialState() });
});

describe('Calendar View', () => {
  // CT-11: Calendar renders projects with dates as colored bars
  it('CT-11: renders projects with dates as colored bars', async () => {
    const user = userEvent.setup();
    render(<App />);

    const calendarToggle = screen.getByTestId('view-toggle-kalender');
    await user.click(calendarToggle);

    // p09 (in_arbeit) spans multiple weeks — may render multiple bars
    const bars = screen.getAllByTestId('calendar-bar-p09');
    expect(bars.length).toBeGreaterThan(0);
    // All bars have the in_arbeit state color (green)
    expect(bars[0]).toHaveStyle({ backgroundColor: '#22C55E' });
  });

  // CT-12: Calendar renders single-date project as single-day block
  it('CT-12: renders single-date project as single-day block', async () => {
    const user = userEvent.setup();
    render(<App />);

    const calendarToggle = screen.getByTestId('view-toggle-kalender');
    await user.click(calendarToggle);

    // p04 has only plannedStart (no plannedEnd) — renders as a single-day bar
    const bar = screen.getByTestId('calendar-bar-p04');
    expect(bar).toBeInTheDocument();
    // Bar has the angebot state color (light blue)
    expect(bar).toHaveStyle({ backgroundColor: '#93C5FD' });

    // Finding 10: verify exactly one bar segment for this single-day project
    const allBars = screen.getAllByTestId('calendar-bar-p04');
    expect(allBars).toHaveLength(1);
  });

  // CT-16: "X Projekte ohne Termin" counter appears below calendar
  it('CT-16: "X Projekte ohne Termin" counter appears below calendar', async () => {
    const user = userEvent.setup();
    render(<App />);

    const calendarToggle = screen.getByTestId('view-toggle-kalender');
    await user.click(calendarToggle);

    // Finding 1 (R3): verify the actual count, not just the label text.
    // Mock data has 4 projects without dates: p01, p02, p05, p06.
    // The summary counts projects missing BOTH dates (!plannedStart && !plannedEnd),
    // while the calendar filters on plannedStart alone. The gap would only surface
    // for a project with plannedEnd but no plannedStart — which the API rejects
    // (project-dates.ts) AND the DB rejects via the projects_end_requires_start
    // CHECK constraint (#54, migration 0006). The state is unreachable, so the
    // divergent filters are internally consistent against valid data.
    const counter = screen.getByTestId('no-dates-counter');
    expect(counter).toBeInTheDocument();
    expect(counter).toHaveTextContent('4 Projekte ohne Termin');
  });

  // Clicking the "no-dates" counter switches to kanban with the no-dates filter
  // applied — only projects missing both planned dates remain visible.
  it('clicking the no-dates counter filters Kanban to projects without dates', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Switch to calendar view
    await user.click(screen.getByTestId('view-toggle-kalender'));

    // Click the counter
    await user.click(screen.getByTestId('no-dates-counter'));

    // Should be back on Kanban
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument();

    // p01 (anfrage, no dates) — visible
    expect(screen.getByTestId('project-card-p01')).toBeInTheDocument();
    // p07 (geplant, has both plannedStart and plannedEnd from seed) — NOT visible
    expect(screen.queryByTestId('project-card-p07')).not.toBeInTheDocument();

    // The "Filter aufheben" button is shown so the user can clear the filter
    expect(screen.getByTestId('clear-filter')).toBeInTheDocument();
  });

  // The no-dates filter is mutually exclusive with the workflow-state filter.
  it('clicking a workflow-state filter clears the no-dates filter', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Activate the no-dates filter via the calendar route.
    await user.click(screen.getByTestId('view-toggle-kalender'));
    await user.click(screen.getByTestId('no-dates-counter'));

    // Sanity: only no-dates projects visible.
    expect(screen.queryByTestId('project-card-p07')).not.toBeInTheDocument();

    // Now click an action-state filter — this should switch filters.
    await user.click(screen.getByTestId('summary-action-anfrage'));

    // p01 is in anfrage and has no dates → still visible.
    expect(screen.getByTestId('project-card-p01')).toBeInTheDocument();
    // p13 (rechnung_faellig) is filtered out by the state filter.
    expect(screen.queryByTestId('project-card-p13')).not.toBeInTheDocument();
  });

  // CT-17: Changing dates in detail panel updates calendar bar position
  // Finding 8 (R3): use a relative end date so the test never depends on
  // absolute calendar-week boundaries. Asserting bars exist with correct
  // color is the point of CT-17; exact segment count is fragile.
  it('CT-17: changing dates in detail panel is reflected in calendar view', async () => {
    const user = userEvent.setup();

    // Compute a relative end date 14 days from now (guarantees multi-week span)
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 14);
    const endDateStr = endDate.toISOString().split('T')[0];

    // Mock the successful PATCH response. Without this the audit's new
    // fail-fast default would reject fetch and the store would revert the
    // optimistic update, making the "new end date shows up in the calendar"
    // assertion meaningless — the calendar would render the old bars.
    const p07 = mockProjects.find((p) => p.id === 'p07')!;
    mockFetchJson(fetchSpy, { ...p07, plannedEnd: endDateStr });

    render(<App />);

    // Open detail for p07 (geplant, has dates starting daysFromNow(3))
    const card = screen.getByTestId('project-card-p07');
    await user.click(card);

    // Extend end date — bar should span longer in the calendar
    const endInput = screen.getByTestId('detail-date-end') as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: endDateStr } });

    // Verify store updated (optimistic).
    const project = useProjectStore.getState().projects.find((p) => p.id === 'p07');
    expect(project?.plannedEnd).toBe(endDateStr);

    // Wait for the PATCH to complete so the optimistic value is confirmed,
    // not subsequently reverted by a pending rejection.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/projects/p07/dates',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining(`"plannedEnd":"${endDateStr}"`),
        }),
      );
    });
    expect(useProjectStore.getState().projects.find((p) => p.id === 'p07')?.plannedEnd).toBe(
      endDateStr,
    );

    // Close detail panel
    await user.click(screen.getByTestId('detail-close'));

    // Switch to calendar view
    const calendarToggle = screen.getByTestId('view-toggle-kalender');
    await user.click(calendarToggle);

    // p07 should appear as calendar bar(s) with geplant color
    const bars = screen.getAllByTestId('calendar-bar-p07');
    expect(bars.length).toBeGreaterThanOrEqual(1);
    expect(bars[0]).toHaveStyle({ backgroundColor: '#3B82F6' });
  });

  // Finding 10 (R3): clicking a calendar bar opens the detail panel (AC-4)
  it('clicking a calendar bar opens the detail panel', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Switch to calendar view
    const calendarToggle = screen.getByTestId('view-toggle-kalender');
    await user.click(calendarToggle);

    // p09 (in_arbeit) has dates and appears in the calendar
    const bar = screen.getAllByTestId('calendar-bar-p09')[0];
    await user.click(bar);

    // Detail panel should open showing p09's data
    const panel = screen.getByTestId('detail-panel');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent('2026-028');
    expect(panel).toHaveTextContent('Malerarbeiten Bürokomplex Weber');
  });

  // Spec §8.3.1: week view toggle is available
  it('week view toggle is present and switches to week view', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByTestId('view-toggle-kalender'));

    // Toggle buttons are present
    const monthBtn = screen.getByTestId('calendar-toggle-month');
    const weekBtn = screen.getByTestId('calendar-toggle-week');
    expect(monthBtn).toHaveTextContent('Monat');
    expect(weekBtn).toHaveTextContent('Woche');

    // Default is month view — grid has multiple week rows
    const grid = screen.getByTestId('calendar-grid');
    const weekRows = grid.querySelectorAll('.weekRow');
    expect(weekRows.length).toBeGreaterThan(1);

    // Switch to week view — grid has exactly one week row
    await user.click(weekBtn);
    const weekGrid = screen.getByTestId('calendar-grid');
    const singleWeekRows = weekGrid.querySelectorAll('.weekRow');
    expect(singleWeekRows).toHaveLength(1);

    // Label shows date range instead of month name
    const label = screen.getByTestId('calendar-month-label');
    expect(label.textContent).toMatch(/\d{2}\.\d{2}\.\s*–\s*\d{2}\.\d{2}\.\d{4}/);

    // Switch back to month view
    await user.click(monthBtn);
    const monthGrid = screen.getByTestId('calendar-grid');
    expect(monthGrid.querySelectorAll('.weekRow').length).toBeGreaterThan(1);
  });

  // AC-19: Calendar week starts on Monday
  it('AC-19: calendar grid week starts on Monday', async () => {
    const user = userEvent.setup();
    render(<App />);

    const calendarToggle = screen.getByTestId('view-toggle-kalender');
    await user.click(calendarToggle);

    const grid = screen.getByTestId('calendar-grid');
    const headerCells = grid.querySelectorAll('.headerCell');
    expect(headerCells[0]).toHaveTextContent('Mo');
    expect(headerCells[6]).toHaveTextContent('So');
  });
});
