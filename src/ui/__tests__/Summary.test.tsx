import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { mockProjects } from '@/test/fixtures/mockProjects';
import { mockConfirmAccept } from '@/test/confirmHelpers';
import { installFailingFetch, mockFetchJson, type FetchSpy } from '@/test/fetchMock';
import { App } from '@/App';

// Each test that triggers a mutation must configure fetchSpy explicitly.
// The src/test/setup.ts default now fails loudly on unconfigured calls — see
// src/ui/__tests__/auth.test.tsx for the gold-standard pattern.
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

describe('Summary Area', () => {
  // AC-8: Summary area shows counts for action states and aged buffer items
  it('AC-8: summary area shows aged buffer indicators', () => {
    render(<App />);

    // p04 (angebot, 18 days old, threshold 14) is an aged buffer project
    const bufferIndicator = screen.getByTestId('summary-buffer-angebot');
    expect(bufferIndicator).toBeInTheDocument();
    expect(bufferIndicator).toHaveTextContent('Angebot');
    expect(bufferIndicator).toHaveTextContent('>14 Tagen');
  });

  // Finding 2: AC-8 also requires action-state counts on initial load
  it('AC-8: summary area shows action-state counts on initial load', () => {
    render(<App />);

    // Mock data has: 2× Anfrage, 2× Beauftragt, 3× Rechnung fällig
    const anfrage = screen.getByTestId('summary-action-anfrage');
    expect(anfrage).toHaveTextContent('2');
    expect(anfrage).toHaveTextContent('Anfrage');

    const beauftragt = screen.getByTestId('summary-action-beauftragt');
    expect(beauftragt).toHaveTextContent('2');
    expect(beauftragt).toHaveTextContent('Beauftragt');

    const rechnung = screen.getByTestId('summary-action-rechnung_faellig');
    expect(rechnung).toHaveTextContent('3');
    expect(rechnung).toHaveTextContent('Rechnung fällig');
  });

  // CT-13: Summary area updates after a state change
  it('CT-13: summary area updates after a state change', async () => {
    const user = userEvent.setup();
    mockConfirmAccept();

    // Mock the successful transition — p13 (rechnung_faellig) → abgerechnet.
    const p13 = mockProjects.find((p) => p.id === 'p13')!;
    mockFetchJson(fetchSpy, { ...p13, status: 'abgerechnet' });

    render(<App />);

    // Initially: 3 Rechnung fällig
    const rechnungIndicator = screen.getByTestId('summary-action-rechnung_faellig');
    expect(rechnungIndicator).toHaveTextContent('3');

    // Move one rechnung_faellig project forward
    const forwardBtn = screen.getByTestId('forward-button-p13');
    await user.click(forwardBtn);

    // Now should be 2 (transition runs after confirm resolves)
    await waitFor(() => {
      expect(rechnungIndicator).toHaveTextContent('2');
    });

    // Hedge: verify the store called the forward endpoint for p13.
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/projects/p13/transition/forward',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // CT-14: Clicking a summary indicator filters the Kanban to matching projects
  it('CT-14: clicking a summary indicator filters the Kanban', async () => {
    const user = userEvent.setup();
    render(<App />);

    const rechnungIndicator = screen.getByTestId('summary-action-rechnung_faellig');
    await user.click(rechnungIndicator);

    // Only rechnung_faellig cards should be visible
    const rechnungColumn = screen.getByTestId('kanban-column-rechnung_faellig');
    expect(rechnungColumn).toHaveTextContent('3');

    // Other columns should be empty (count = 0)
    const anfragenColumn = screen.getByTestId('column-count-anfrage');
    expect(anfragenColumn).toHaveTextContent('0');
  });

  // Finding 3: AC-9 requires filtering by buffer indicator too
  it('CT-14b: clicking a buffer aging indicator filters the Kanban', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Click the buffer indicator for angebot
    const bufferIndicator = screen.getByTestId('summary-buffer-angebot');
    await user.click(bufferIndicator);

    // Filter is by state AND aging — only the aged project (p04) should show
    const angebotCount = screen.getByTestId('column-count-angebot');
    expect(angebotCount).toHaveTextContent('1');

    // Non-angebot columns should be empty
    const anfragenCount = screen.getByTestId('column-count-anfrage');
    expect(anfragenCount).toHaveTextContent('0');

    const rechnungCount = screen.getByTestId('column-count-rechnung_faellig');
    expect(rechnungCount).toHaveTextContent('0');
  });

  // Finding 4 (R2): zero-count action state should not render an indicator
  it('zero-count action state is excluded from summary', async () => {
    const user = userEvent.setup();
    mockConfirmAccept();

    // Mock two successful forward transitions — p01 and p02 both leave anfrage.
    const p01 = mockProjects.find((p) => p.id === 'p01')!;
    const p02 = mockProjects.find((p) => p.id === 'p02')!;
    mockFetchJson(fetchSpy, { ...p01, status: 'angebot' });
    mockFetchJson(fetchSpy, { ...p02, status: 'angebot' });

    render(<App />);

    // Initially anfrage has 2 projects (p01, p02)
    expect(screen.getByTestId('summary-action-anfrage')).toBeInTheDocument();

    // Move both anfrage projects forward to angebot
    await user.click(screen.getByTestId('forward-button-p01'));
    await user.click(screen.getByTestId('forward-button-p02'));

    // Anfrage now has 0 projects — indicator should be absent
    await waitFor(() => {
      expect(screen.queryByTestId('summary-action-anfrage')).not.toBeInTheDocument();
    });

    // Verify both endpoints were hit.
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/projects/p01/transition/forward',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/projects/p02/transition/forward',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // CT-15: "Filter aufheben" button clears the filter
  it('CT-15: "Filter aufheben" button clears the filter', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Apply filter
    const rechnungIndicator = screen.getByTestId('summary-action-rechnung_faellig');
    await user.click(rechnungIndicator);

    // Clear filter
    const clearBtn = screen.getByTestId('clear-filter');
    expect(clearBtn).toBeInTheDocument();
    await user.click(clearBtn);

    // Filter should be cleared — anfrage should have projects again
    const anfragenCount = screen.getByTestId('column-count-anfrage');
    expect(anfragenCount).toHaveTextContent('2');
  });
});
