/**
 * ProjectDetailPanel — "Öffnen" affordance (AC-207).
 *
 * The quick-glance panel exposes an `Öffnen` affordance that navigates
 * the app to `/projects/:id`. Per spec §8.4, the affordance is rendered
 * whenever the panel is, and the navigation preserves the originating
 * view (Kanban or Calendar) as the back target so the user can return
 * without re-navigating.
 *
 * The panel's other behaviors (date editing, transitions, activity
 * feed) are covered by existing E2E specs; this file pins only the
 * navigation affordance the detail-page iteration introduces.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { Customer, Project } from '@/domain/types';

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    projectApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], total: 0 } }),
      get: vi.fn(),
      update: vi.fn(),
      updateDates: vi.fn(),
      delete: vi.fn(),
      transitionForward: vi.fn(),
      transitionBackward: vi.fn(),
    },
    customerApi: { list: vi.fn(), get: vi.fn() },
    userApi: { list: vi.fn() },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
    auditApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null } }),
    },
  };
});

const { ProjectDetailPanel } = await import('@/ui/detail/ProjectDetailPanel');
const { useAuthStore } = await import('@/state/authStore');
const { useProjectStore } = await import('@/state/projectStore');

const CUSTOMER: Customer = {
  id: 'c-1',
  name: 'Kunde GmbH',
  phone: null,
  email: null,
  address: null,
  notes: null,
  createdAt: '2026-03-30T00:00:00Z',
  updatedAt: '2026-03-30T00:00:00Z',
  createdBy: null,
  updatedBy: null,
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-42',
    number: 'P-042',
    title: 'Dachsanierung',
    status: 'geplant',
    statusChangedAt: '2026-04-01T00:00:00Z',
    plannedStart: '2026-05-01',
    plannedEnd: '2026-06-01',
    customerId: 'c-1',
    customer: CUSTOMER,
    assignedWorkers: [],
    estimatedValue: null,
    notes: null,
    deleted: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return (
    <span data-testid="location-probe">
      {loc.pathname}
      {loc.search}
    </span>
  );
}

function setAuthUser(roles: string[]): void {
  useAuthStore.setState({
    authUser: {
      id: 'u-1',
      username: 'owner',
      displayName: 'Owner',
      roles,
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });
}

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

beforeEach(() => {
  setAuthUser(['owner']);
  useProjectStore.setState({
    projects: [makeProject()],
    mutationInFlight: {},
    mutationError: null,
  });
});

function renderPanelAt(initialPath: string): Project {
  const project = makeProject();
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ProjectDetailPanel project={project} onClose={() => {}} />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return project;
}

describe('ProjectDetailPanel — Öffnen affordance (AC-207)', () => {
  it('renders the Öffnen affordance whenever the panel is open', () => {
    renderPanelAt('/kanban');
    expect(screen.getByTestId('detail-open-page')).toBeInTheDocument();
  });

  it('navigates to /projects/:id when clicked', async () => {
    renderPanelAt('/kanban');

    await userEvent.click(screen.getByTestId('detail-open-page'));

    expect(screen.getByTestId('location-probe').textContent).toMatch(/^\/projects\/p-42/);
  });

  it('preserves the originating view (Kanban) so the user can navigate back', async () => {
    renderPanelAt('/kanban');

    await userEvent.click(screen.getByTestId('detail-open-page'));

    // The back target is preserved as a query param (`from=kanban`) or
    // equivalent search entry — the exact mechanism is an implementation
    // choice, but the originating view must be recoverable from the URL
    // per spec §8.4 ("preserves the originating view as the back target").
    const pathAndSearch = screen.getByTestId('location-probe').textContent ?? '';
    expect(pathAndSearch).toContain('/projects/p-42');
    expect(pathAndSearch).toContain('kanban');
  });

  it('preserves the originating view when opened from Calendar', async () => {
    renderPanelAt('/calendar');

    await userEvent.click(screen.getByTestId('detail-open-page'));

    const pathAndSearch = screen.getByTestId('location-probe').textContent ?? '';
    expect(pathAndSearch).toContain('/projects/p-42');
    expect(pathAndSearch).toContain('calendar');
  });
});
