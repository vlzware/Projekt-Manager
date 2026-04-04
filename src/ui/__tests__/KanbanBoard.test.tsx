import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProjectStore } from '@/state/store';
import { STATE_CONFIGS } from '@/config/stateConfig';
import { BRANDING } from '@/config/brandingConfig';
import { App } from '@/App';

import * as collapseTierHook from '@/ui/kanban/useCollapseTier';

// Reset store before each test
beforeEach(() => {
  useProjectStore.setState({
    ...useProjectStore.getInitialState(),
  });
});

describe('Kanban Board', () => {
  // CT-1: Kanban board renders 9 columns with correct German labels
  it('CT-1: renders 9 columns with correct German labels', () => {
    render(<App />);

    const board = screen.getByTestId('kanban-board');
    expect(board).toBeInTheDocument();

    for (const config of STATE_CONFIGS) {
      const column = screen.getByTestId(`kanban-column-${config.key}`);
      expect(column).toBeInTheDocument();
      expect(column).toHaveTextContent(config.label);
    }
  });

  // CT-2: Kanban board distributes mock projects into correct columns
  it('CT-2: distributes mock projects into correct columns', () => {
    render(<App />);

    const projects = useProjectStore.getState().projects;
    for (const config of STATE_CONFIGS) {
      const expectedCount = projects.filter((p) => p.status === config.key).length;
      const countEl = screen.getByTestId(`column-count-${config.key}`);
      expect(countEl).toHaveTextContent(String(expectedCount));
    }
  });
});

describe('Project Card', () => {
  // CT-3: Card displays number, title, customer, date range, entry date
  it('CT-3: displays number, title, customer, date range, entry date', () => {
    render(<App />);

    // p07 has dates, customer, etc.
    const card = screen.getByTestId('project-card-p07');
    expect(card).toHaveTextContent('2026-034');
    expect(card).toHaveTextContent('Wohnzimmer renovieren Klein');
    expect(card).toHaveTextContent('Familie Klein');
    // Finding 15: verify entry date matches DD.MM.YYYY format, not just "seit"
    const entryDate = screen.getByTestId('entry-date-p07');
    expect(entryDate.textContent).toMatch(/seit \d{2}\.\d{2}\.\d{4}/);
    // Finding 2 (R3): p07 has both plannedStart and plannedEnd — verify the
    // card shows a formatted date range (DD.MM. – DD.MM.YYYY), not "Kein Termin"
    expect(card.textContent).toMatch(/\d{2}\.\d{2}\.\s*–\s*\d{2}\.\d{2}\.\d{4}/);
    expect(card.textContent).not.toContain('Kein Termin');
  });

  // CT-4: Card shows "Kein Termin" when dates are missing
  it('CT-4: shows "Kein Termin" when dates are missing', () => {
    render(<App />);

    // p01 has no planned dates
    const card = screen.getByTestId('project-card-p01');
    expect(card).toHaveTextContent('Kein Termin');
  });

  // CT-5: Card shows bold entry date when aging threshold exceeded
  it('CT-5: shows bold entry date when aging threshold exceeded', () => {
    render(<App />);

    // p02 is in anfrage with statusChangedAt 10 days ago (threshold = 3 days)
    const entryDate = screen.getByTestId('entry-date-p02');
    expect(entryDate).toHaveClass('entryDateBold');
  });

  // Finding 7: buffer-state card shows bold entry date when threshold exceeded
  it('CT-5b: buffer-state card shows bold entry date when threshold exceeded', () => {
    render(<App />);

    // p04 is in angebot (buffer) with statusChangedAt 18 days ago (threshold = 14 days)
    const entryDate = screen.getByTestId('entry-date-p04');
    expect(entryDate).toHaveClass('entryDateBold');
  });

  // CT-6: Clicking a card opens the detail panel
  it('CT-6: clicking a card opens the detail panel', async () => {
    const user = userEvent.setup();
    render(<App />);

    const card = screen.getByTestId('project-card-p07');
    await user.click(card);

    const panel = screen.getByTestId('detail-panel');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent('2026-034');
    expect(panel).toHaveTextContent('Wohnzimmer renovieren Klein');
  });

  // CT-7: [→] button triggers state change and moves card to next column
  it('CT-7: forward button triggers state change with confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);

    // p07 is in 'geplant' — forward should move to 'in_arbeit'
    const forwardBtn = screen.getByTestId('forward-button-p07');
    await user.click(forwardBtn);

    // Finding 4: verify full dialog format, not just state names
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('Status ändern: Geplant → In Arbeit?'),
    );

    // Card should now be in 'in_arbeit' column
    const inArbeitColumn = screen.getByTestId('kanban-column-in_arbeit');
    expect(within(inArbeitColumn).getByTestId('project-card-p07')).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  // Finding 10 (R2): dialog cancellation — project must NOT transition when user clicks Abbrechen
  it('CT-7b: forward button does not transition when confirm is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<App />);

    // p07 is in 'geplant' — click forward, but cancel the dialog
    const forwardBtn = screen.getByTestId('forward-button-p07');
    await user.click(forwardBtn);

    expect(window.confirm).toHaveBeenCalled();

    // Card should remain in 'geplant' column
    const geplantColumn = screen.getByTestId('kanban-column-geplant');
    expect(within(geplantColumn).getByTestId('project-card-p07')).toBeInTheDocument();

    // Card should NOT be in 'in_arbeit'
    const inArbeitColumn = screen.getByTestId('kanban-column-in_arbeit');
    expect(within(inArbeitColumn).queryByTestId('project-card-p07')).not.toBeInTheDocument();

    vi.restoreAllMocks();
  });

  // CT-8: [→] button is hidden on Erledigt cards
  it('CT-8: forward button is hidden on Erledigt cards', () => {
    render(<App />);

    // p18 is in erledigt
    const card = screen.getByTestId('project-card-p18');
    expect(card).toBeInTheDocument();
    expect(screen.queryByTestId('forward-button-p18')).not.toBeInTheDocument();
  });
});

describe('Card Sort Order', () => {
  // Finding 13: cards within a column are sorted by statusChangedAt ascending
  // NOTE: This test is coupled to mock data IDs and their daysAgo values:
  //   p15 = daysAgo(8), p13 = daysAgo(5), p14 = daysAgo(2)
  // If mock data changes (IDs, daysAgo values, or number of rechnung_faellig projects),
  // this test must be updated accordingly.
  it('cards in rechnung_faellig are sorted by statusChangedAt ascending (oldest first)', () => {
    render(<App />);

    const column = screen.getByTestId('kanban-column-rechnung_faellig');
    const cards = column.querySelectorAll('[data-testid^="project-card-"]');

    // p15 = 8 days old, p13 = 5 days old, p14 = 2 days old
    // Ascending by statusChangedAt: p15 (oldest) → p13 → p14 (newest)
    expect(cards[0]).toHaveAttribute('data-testid', 'project-card-p15');
    expect(cards[1]).toHaveAttribute('data-testid', 'project-card-p13');
    expect(cards[2]).toHaveAttribute('data-testid', 'project-card-p14');
  });
});

describe('Filter Clearing on View Switch', () => {
  // Finding 14: switching views clears the filter
  it('view switch clears active filter', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Apply a filter
    const rechnungIndicator = screen.getByTestId('summary-action-rechnung_faellig');
    await user.click(rechnungIndicator);

    // Verify filter is active — anfrage should be 0
    expect(screen.getByTestId('column-count-anfrage')).toHaveTextContent('0');

    // Switch to calendar view
    await user.click(screen.getByTestId('view-toggle-kalender'));

    // Switch back to kanban
    await user.click(screen.getByTestId('view-toggle-kanban'));

    // Filter should be cleared — all projects visible again
    expect(screen.getByTestId('column-count-anfrage')).toHaveTextContent('2');
    expect(screen.getByTestId('column-count-rechnung_faellig')).toHaveTextContent('3');
  });
});

describe('Visual Distinction', () => {
  // AC-11: Action columns are visually distinct from buffer columns
  it('AC-11: action columns have distinct styling from buffer columns', () => {
    render(<App />);

    // Action states use columnAction class
    expect(screen.getByTestId('kanban-column-anfrage')).toHaveClass('columnAction');
    expect(screen.getByTestId('kanban-column-beauftragt')).toHaveClass('columnAction');
    expect(screen.getByTestId('kanban-column-rechnung_faellig')).toHaveClass('columnAction');

    // Buffer states use columnBuffer class
    expect(screen.getByTestId('kanban-column-angebot')).toHaveClass('columnBuffer');
    expect(screen.getByTestId('kanban-column-geplant')).toHaveClass('columnBuffer');
    expect(screen.getByTestId('kanban-column-abnahme')).toHaveClass('columnBuffer');
    expect(screen.getByTestId('kanban-column-abgerechnet')).toHaveClass('columnBuffer');

    // Active and done
    expect(screen.getByTestId('kanban-column-in_arbeit')).toHaveClass('columnActive');
    expect(screen.getByTestId('kanban-column-erledigt')).toHaveClass('columnDone');
  });

  // AC-13: Aged buffer items show "seit X Tagen" indicator in the UI
  it('AC-13: aged buffer card shows aging text', () => {
    render(<App />);

    // p04 is in angebot (buffer), 18 days old, threshold = 14 days
    const agingText = screen.getByTestId('aging-text-p04');
    expect(agingText).toBeInTheDocument();
    expect(agingText.textContent).toMatch(/seit \d+ Tagen/);
  });

  // AC-12: Consistent color across Kanban dot, detail badge, and calendar bar
  it('AC-12: state color is consistent across all three views', async () => {
    const user = userEvent.setup();
    render(<App />);

    // p09 (in_arbeit, #22C55E) has dates and appears in all views

    // 1. Kanban card dot
    const card = screen.getByTestId('project-card-p09');
    const dot = card.querySelector('.dot');
    expect(dot).toHaveStyle({ backgroundColor: '#22C55E' });

    // 2. Detail panel badge
    await user.click(card);
    const badge = screen.getByTestId('detail-status-badge');
    expect(badge).toHaveStyle({ backgroundColor: '#22C55E' });

    // 3. Calendar bar (p09 spans multiple weeks — check first bar)
    await user.click(screen.getByTestId('detail-close'));
    await user.click(screen.getByTestId('view-toggle-kalender'));
    const bars = screen.getAllByTestId('calendar-bar-p09');
    expect(bars[0]).toHaveStyle({ backgroundColor: '#22C55E' });
  });
});

describe('Entry Date on All State Types', () => {
  // Finding 8 (R2): AC-15 says "every card" shows entry date — verify for erledigt (done state)
  it('AC-15: erledigt card shows entry date', () => {
    render(<App />);

    const entryDate = screen.getByTestId('entry-date-p18');
    expect(entryDate).toBeInTheDocument();
    expect(entryDate.textContent).toMatch(/seit \d{2}\.\d{2}\.\d{4}/);
  });
});

describe('Date Formatting', () => {
  // AC-19: Dates display in German format DD.MM.YYYY
  it('AC-19: entry date uses German DD.MM.YYYY format', () => {
    render(<App />);

    const entryDate = screen.getByTestId('entry-date-p01');
    expect(entryDate.textContent).toMatch(/seit \d{2}\.\d{2}\.\d{4}/);
  });
});

describe('Branding', () => {
  // AC-27: changing branding config changes all instances
  it('AC-27: header and footer are driven by branding config, not hardcoded', () => {
    const original = { ...BRANDING };

    // Override with non-default values — if components were hardcoded this would fail
    Object.assign(BRANDING, { appName: 'Testfirma', footerText: 'Custom Footer' });

    render(<App />);
    expect(document.querySelector('header')).toHaveTextContent('Testfirma');
    expect(document.querySelector('footer')).toHaveTextContent('Custom Footer');

    // Restore
    Object.assign(BRANDING, original);
  });
});

describe('Responsive Column Collapse', () => {
  // AC-28: Tier-3 columns collapse — cards hidden, count visible
  it('AC-28: tier-3 columns show header and count but no cards', () => {
    vi.spyOn(collapseTierHook, 'useCollapseTier').mockReturnValue(3);
    render(<App />);

    // All three tier-3 columns collapsed
    for (const key of ['angebot', 'abgerechnet', 'erledigt']) {
      const col = screen.getByTestId(`kanban-column-${key}`);
      expect(col).toHaveClass('columnCollapsed');
      // Cards are hidden — no project-card-* inside collapsed column
      expect(col.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(0);
      // Count is still visible
      expect(screen.getByTestId(`column-count-${key}`)).toBeInTheDocument();
    }

    // Tier-2 and tier-1 columns are NOT collapsed
    for (const key of [
      'geplant',
      'in_arbeit',
      'abnahme',
      'anfrage',
      'beauftragt',
      'rechnung_faellig',
    ]) {
      expect(screen.getByTestId(`kanban-column-${key}`)).not.toHaveClass('columnCollapsed');
    }

    vi.restoreAllMocks();
  });

  // AC-29: Tier-2 columns also collapse
  it('AC-29: tier-2 and tier-3 columns all collapse, action columns remain', () => {
    vi.spyOn(collapseTierHook, 'useCollapseTier').mockReturnValue(2);
    render(<App />);

    // Tier-3 collapsed (including abgerechnet)
    for (const key of ['angebot', 'abgerechnet', 'erledigt']) {
      expect(screen.getByTestId(`kanban-column-${key}`)).toHaveClass('columnCollapsed');
    }

    // Tier-2 collapsed
    for (const key of ['geplant', 'in_arbeit', 'abnahme']) {
      expect(screen.getByTestId(`kanban-column-${key}`)).toHaveClass('columnCollapsed');
    }

    // Tier-1 (action) still expanded
    for (const key of ['anfrage', 'beauftragt', 'rechnung_faellig']) {
      expect(screen.getByTestId(`kanban-column-${key}`)).not.toHaveClass('columnCollapsed');
    }

    vi.restoreAllMocks();
  });

  // AC-30: Action columns collapse last — at tier 1, everything is collapsed
  it('AC-30: at tier 1, all columns collapse including action columns', () => {
    vi.spyOn(collapseTierHook, 'useCollapseTier').mockReturnValue(1);
    render(<App />);

    // Every column is collapsed
    for (const key of [
      'anfrage',
      'angebot',
      'beauftragt',
      'geplant',
      'in_arbeit',
      'abnahme',
      'rechnung_faellig',
      'abgerechnet',
      'erledigt',
    ]) {
      const col = screen.getByTestId(`kanban-column-${key}`);
      expect(col).toHaveClass('columnCollapsed');
      expect(col.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(0);
    }

    vi.restoreAllMocks();
  });

  // AC-31: Click collapsed column to expand, click header to collapse
  it('AC-31: clicking a collapsed column expands it, clicking header collapses it', async () => {
    const user = userEvent.setup();
    vi.spyOn(collapseTierHook, 'useCollapseTier').mockReturnValue(3);
    render(<App />);

    // Angebot is collapsed — no cards
    const angebotCol = screen.getByTestId('kanban-column-angebot');
    expect(angebotCol).toHaveClass('columnCollapsed');
    expect(angebotCol.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(0);

    // Click to expand
    await user.click(angebotCol);

    // Now expanded — cards visible
    const expandedCol = screen.getByTestId('kanban-column-angebot');
    expect(expandedCol).not.toHaveClass('columnCollapsed');
    expect(expandedCol.querySelectorAll('[data-testid^="project-card-"]').length).toBeGreaterThan(
      0,
    );

    // Click the header to collapse again
    const header = screen.getByTestId('column-header-angebot');
    await user.click(header);

    const collapsedAgain = screen.getByTestId('kanban-column-angebot');
    expect(collapsedAgain).toHaveClass('columnCollapsed');

    vi.restoreAllMocks();
  });
});
