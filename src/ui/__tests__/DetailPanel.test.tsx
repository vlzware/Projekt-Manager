import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { mockProjects } from '@/data/mockProjects';
import { App } from '@/App';

beforeEach(() => {
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

describe('Detail Panel Transitions', () => {
  // CT-9: Backward transition via detail panel moves card to previous column
  it('CT-9: backward transition via detail panel moves card to previous column', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);

    // p07 is in 'geplant' — click to open detail
    const card = screen.getByTestId('project-card-p07');
    await user.click(card);

    // Finding 16: verify button labels match spec
    const backwardBtn = screen.getByTestId('detail-backward-button');
    expect(backwardBtn).toHaveTextContent('Vorheriger Schritt');
    const forwardBtn = screen.getByTestId('detail-forward-button');
    expect(forwardBtn).toHaveTextContent('Nächster Schritt');

    // Click backward button
    await user.click(backwardBtn);

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Geplant → Beauftragt'));

    // Verify the project moved
    const project = useProjectStore.getState().projects.find((p) => p.id === 'p07');
    expect(project?.status).toBe('beauftragt');

    vi.restoreAllMocks();
  });

  // Finding 3 (R3): backward transition dialog cancellation — project must NOT
  // transition when user clicks Abbrechen (mirrors CT-7b for forward in KanbanBoard)
  it('CT-9b: backward transition does not happen when confirm is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<App />);

    // p07 is in 'geplant' — click to open detail
    const card = screen.getByTestId('project-card-p07');
    await user.click(card);

    // Click backward button — confirm returns false
    const backwardBtn = screen.getByTestId('detail-backward-button');
    await user.click(backwardBtn);

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Geplant → Beauftragt'));

    // Project should remain in geplant
    const project = useProjectStore.getState().projects.find((p) => p.id === 'p07');
    expect(project?.status).toBe('geplant');

    vi.restoreAllMocks();
  });

  // CT-10: Backward button is hidden for Anfrage and Erledigt
  it('CT-10: backward button is hidden for Anfrage', async () => {
    const user = userEvent.setup();
    render(<App />);

    // p01 is in 'anfrage'
    const card = screen.getByTestId('project-card-p01');
    await user.click(card);

    expect(screen.queryByTestId('detail-backward-button')).not.toBeInTheDocument();
  });

  it('CT-10: backward button is hidden for Erledigt', async () => {
    const user = userEvent.setup();
    render(<App />);

    // p18 is in 'erledigt'
    const card = screen.getByTestId('project-card-p18');
    await user.click(card);

    expect(screen.queryByTestId('detail-backward-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-forward-button')).not.toBeInTheDocument();
  });
});

describe('Detail Panel Fields', () => {
  // AC-4: Detail panel shows all available fields for a complete project
  it('AC-4: shows all available fields for a complete project', async () => {
    const user = userEvent.setup();
    render(<App />);

    // p09 has all optional fields: phone, email, address, workers, estimated value, notes
    const card = screen.getByTestId('project-card-p09');
    await user.click(card);

    const panel = screen.getByTestId('detail-panel');

    // Project number and title
    expect(panel).toHaveTextContent('2026-028');
    expect(panel).toHaveTextContent('Malerarbeiten Bürokomplex Weber');

    // Status badge with label
    expect(screen.getByTestId('detail-status-badge')).toHaveTextContent('In Arbeit');

    // Customer name
    expect(panel).toHaveTextContent('Weber Immobilien AG');

    // Phone as tel: link
    const phoneLink = panel.querySelector('a[href^="tel:"]');
    expect(phoneLink).toBeInTheDocument();
    expect(phoneLink).toHaveTextContent('+49 221 6665544');

    // Email as mailto: link
    const emailLink = panel.querySelector('a[href^="mailto:"]');
    expect(emailLink).toBeInTheDocument();
    expect(emailLink).toHaveTextContent('immobilien@weber.de');

    // Address fields
    expect(panel).toHaveTextContent('Rheinuferstr. 20');
    expect(panel).toHaveTextContent('50668');
    expect(panel).toHaveTextContent('Köln');

    // Google Maps link
    const mapsLink = panel.querySelector('a[href*="google.com/maps"]');
    expect(mapsLink).toBeInTheDocument();

    // Workers
    expect(panel).toHaveTextContent('Thomas Braun');
    expect(panel).toHaveTextContent('Markus Scholz');
    expect(panel).toHaveTextContent('Andreas Richter');
    expect(panel).toHaveTextContent('Stefan Wolf');

    // Estimated value in German locale (24.000,00 €)
    expect(panel).toHaveTextContent('24.000,00');

    // Notes
    expect(panel).toHaveTextContent('Großprojekt');

    // Timestamps
    expect(panel).toHaveTextContent('Erstellt:');
    expect(panel).toHaveTextContent('Aktualisiert:');
    expect(panel).toHaveTextContent('Status seit:');
  });

  // AC-20: UI does not crash on projects with missing optional fields
  it('AC-20: detail panel handles missing optional fields', async () => {
    const user = userEvent.setup();
    render(<App />);

    // p06 has minimal data: no address, no phone, no email, no workers, no notes
    const card = screen.getByTestId('project-card-p06');
    await user.click(card);

    const panel = screen.getByTestId('detail-panel');
    expect(panel).toBeInTheDocument();

    // Basic fields are present
    expect(panel).toHaveTextContent('2026-039');
    expect(panel).toHaveTextContent('Malerarbeiten Neubau Yilmaz');
    expect(panel).toHaveTextContent('Yilmaz Bau GmbH');

    // No phone/email links
    expect(panel.querySelector('a[href^="tel:"]')).not.toBeInTheDocument();
    expect(panel.querySelector('a[href^="mailto:"]')).not.toBeInTheDocument();

    // No address / Google Maps link
    expect(panel.querySelector('a[href*="google.com/maps"]')).not.toBeInTheDocument();

    // Estimated value is still shown (p06 has estimatedValue: 12000)
    expect(panel).toHaveTextContent('12.000,00');
  });
});

describe('Date Clearing', () => {
  // Finding 7 (R2): clearing a date input must actually clear the project's date
  it('clearing a date input removes the date from the project', async () => {
    const user = userEvent.setup();
    render(<App />);

    // p07 has both plannedStart and plannedEnd — open detail
    const card = screen.getByTestId('project-card-p07');
    await user.click(card);

    // Verify end date is initially set
    const project = useProjectStore.getState().projects.find((p) => p.id === 'p07');
    expect(project?.plannedEnd).toBeDefined();

    // Clear the end date by setting input value to empty string
    const endInput = screen.getByTestId('detail-date-end') as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: '' } });

    // The project's plannedEnd should now be undefined (cleared)
    const updated = useProjectStore.getState().projects.find((p) => p.id === 'p07');
    expect(updated?.plannedEnd).toBeUndefined();

    // Start date should remain unchanged
    expect(updated?.plannedStart).toBe(project?.plannedStart);
  });
});

describe('AC-7 Kanban Side', () => {
  // Finding 11: after date change in detail panel, Kanban card shows updated date
  it('AC-7: date change in detail panel is reflected on the Kanban card', async () => {
    const user = userEvent.setup();
    render(<App />);

    // p07 is in geplant with existing dates — open detail
    const card = screen.getByTestId('project-card-p07');
    await user.click(card);

    // Change end date to a specific date
    const endInput = screen.getByTestId('detail-date-end') as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: '2026-04-25' } });

    // Close detail panel
    await user.click(screen.getByTestId('detail-close'));

    // Verify the Kanban card now shows the new date (25.04.2026)
    const kanbanCard = screen.getByTestId('project-card-p07');
    expect(kanbanCard).toHaveTextContent('25.04.2026');
  });
});
