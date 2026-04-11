/**
 * projectStore tests — covers transitions, optimistic updates, rollback,
 * mutationInFlight tracking, and session-expiry delegation.
 *
 * Mocks the API client and the auth store. Tests run against the real
 * Zustand store reset between cases.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Project } from '@/domain/types';

// Mock the API client BEFORE importing the store.
vi.mock('@/api/client', () => ({
  projectApi: {
    list: vi.fn(),
    get: vi.fn(),
    transitionForward: vi.fn(),
    transitionBackward: vi.fn(),
    updateDates: vi.fn(),
  },
}));

// Mock the auth store so we can observe session-expired delegation.
const handleSessionExpiredMock = vi.fn();
vi.mock('@/state/authStore', () => ({
  useAuthStore: {
    getState: () => ({ handleSessionExpired: handleSessionExpiredMock }),
  },
}));

import { useProjectStore } from '@/state/projectStore';
import { projectApi } from '@/api/client';

const mockedApi = projectApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  transitionForward: ReturnType<typeof vi.fn>;
  transitionBackward: ReturnType<typeof vi.fn>;
  updateDates: ReturnType<typeof vi.fn>;
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    number: '2026-001',
    title: 'Test project',
    status: 'geplant',
    statusChangedAt: '2026-04-01T10:00:00.000Z',
    customer: { name: 'Familie Test' },
    address: null,
    plannedStart: '2026-04-10',
    plannedEnd: '2026-04-12',
    assignedWorkers: null,
    estimatedValue: null,
    notes: null,
    createdAt: '2026-03-30T10:00:00.000Z',
    updatedAt: '2026-03-30T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handleSessionExpiredMock.mockClear();
  useProjectStore.setState({
    projects: [],
    mutationError: null,
    mutationInFlight: {},
  });
});

describe('projectStore — fetchProjects', () => {
  it('replaces local projects with fetched data on success', async () => {
    const projects = [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })];
    mockedApi.list.mockResolvedValue({
      ok: true,
      data: { data: projects, total: 2 },
    });

    await useProjectStore.getState().fetchProjects();

    expect(useProjectStore.getState().projects).toHaveLength(2);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('leaves projects untouched when the API call fails', async () => {
    useProjectStore.setState({ projects: [makeProject({ id: 'existing' })] });
    mockedApi.list.mockResolvedValue({
      ok: false,
      error: { code: 'NETWORK_ERROR', message: 'Boom' },
      sessionExpired: false,
    });

    await useProjectStore.getState().fetchProjects();

    expect(useProjectStore.getState().projects).toHaveLength(1);
    expect(useProjectStore.getState().projects[0]!.id).toBe('existing');
  });
});

describe('projectStore — transitionForward', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [makeProject({ id: 'p1', status: 'geplant' })] });
  });

  it('moves the project to the next state on success', async () => {
    mockedApi.transitionForward.mockResolvedValue({ ok: true, data: makeProject() });

    useProjectStore.getState().transitionForward('p1');
    // The mutation runs in a microtask — wait for the promise chain to settle.
    await vi.waitFor(() => {
      expect(useProjectStore.getState().projects[0]!.status).toBe('in_arbeit');
    });
    expect(useProjectStore.getState().mutationError).toBeNull();
    expect(useProjectStore.getState().isMutationInFlight('p1')).toBe(false);
  });

  it('marks the mutation in flight while the API call is pending', () => {
    let resolve: (v: unknown) => void = () => {};
    mockedApi.transitionForward.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    useProjectStore.getState().transitionForward('p1');

    expect(useProjectStore.getState().isMutationInFlight('p1')).toBe(true);

    resolve({ ok: true, data: makeProject() });
  });

  it('records an error message and clears the in-flight flag on API failure', async () => {
    mockedApi.transitionForward.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Übergang nicht erlaubt.' },
      sessionExpired: false,
    });

    useProjectStore.getState().transitionForward('p1');
    await vi.waitFor(() => {
      expect(useProjectStore.getState().mutationError).toBe('Übergang nicht erlaubt.');
    });
    // State must NOT have moved
    expect(useProjectStore.getState().projects[0]!.status).toBe('geplant');
    expect(useProjectStore.getState().isMutationInFlight('p1')).toBe(false);
  });

  it('delegates to authStore.handleSessionExpired when the API reports session expiry', async () => {
    mockedApi.transitionForward.mockResolvedValue({
      ok: false,
      error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
      sessionExpired: true,
    });

    useProjectStore.getState().transitionForward('p1');
    await vi.waitFor(() => {
      expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1);
    });
    // Local state is left untouched on session expiry — auth store handles the redirect.
    expect(useProjectStore.getState().projects[0]!.status).toBe('geplant');
    expect(useProjectStore.getState().mutationError).toBeNull();
  });

  it('does nothing when called for an unknown project id', () => {
    useProjectStore.getState().transitionForward('does-not-exist');
    expect(mockedApi.transitionForward).not.toHaveBeenCalled();
    expect(useProjectStore.getState().isMutationInFlight('does-not-exist')).toBe(false);
  });

  it('does nothing when the project is already in a terminal state', () => {
    useProjectStore.setState({ projects: [makeProject({ id: 'p1', status: 'erledigt' })] });
    useProjectStore.getState().transitionForward('p1');
    expect(mockedApi.transitionForward).not.toHaveBeenCalled();
  });
});

describe('projectStore — transitionBackward', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [makeProject({ id: 'p1', status: 'in_arbeit' })] });
  });

  it('moves the project to the previous state on success', async () => {
    mockedApi.transitionBackward.mockResolvedValue({ ok: true, data: makeProject() });

    useProjectStore.getState().transitionBackward('p1');
    await vi.waitFor(() => {
      expect(useProjectStore.getState().projects[0]!.status).toBe('geplant');
    });
    expect(useProjectStore.getState().isMutationInFlight('p1')).toBe(false);
  });

  it('does not move the project when the API rejects the transition', async () => {
    mockedApi.transitionBackward.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Nope.' },
      sessionExpired: false,
    });

    useProjectStore.getState().transitionBackward('p1');
    await vi.waitFor(() => {
      expect(useProjectStore.getState().mutationError).toBe('Nope.');
    });
    expect(useProjectStore.getState().projects[0]!.status).toBe('in_arbeit');
  });

  it('does nothing when the project is at the first state (no previous)', () => {
    useProjectStore.setState({ projects: [makeProject({ id: 'p1', status: 'anfrage' })] });
    useProjectStore.getState().transitionBackward('p1');
    expect(mockedApi.transitionBackward).not.toHaveBeenCalled();
  });
});

describe('projectStore — updateDates (optimistic + rollback)', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        makeProject({
          id: 'p1',
          plannedStart: '2026-04-10',
          plannedEnd: '2026-04-12',
        }),
      ],
    });
  });

  it('applies the new dates immediately (optimistic update)', () => {
    let resolve: (v: unknown) => void = () => {};
    mockedApi.updateDates.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    useProjectStore.getState().updateDates('p1', '2026-05-01', '2026-05-03');

    // Optimistic — applied before the API call resolves
    const p = useProjectStore.getState().projects[0]!;
    expect(p.plannedStart).toBe('2026-05-01');
    expect(p.plannedEnd).toBe('2026-05-03');

    resolve({ ok: true, data: makeProject() });
  });

  it('keeps the optimistic update on success', async () => {
    mockedApi.updateDates.mockResolvedValue({ ok: true, data: makeProject() });

    useProjectStore.getState().updateDates('p1', '2026-05-01', '2026-05-03');
    await vi.waitFor(() => {
      expect(useProjectStore.getState().isMutationInFlight('p1')).toBe(false);
    });

    const p = useProjectStore.getState().projects[0]!;
    expect(p.plannedStart).toBe('2026-05-01');
    expect(p.plannedEnd).toBe('2026-05-03');
  });

  it('rolls back the optimistic update on API failure', async () => {
    mockedApi.updateDates.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Ungültiges Datum.' },
      sessionExpired: false,
    });

    useProjectStore.getState().updateDates('p1', '2026-05-01', '2026-05-03');
    await vi.waitFor(() => {
      expect(useProjectStore.getState().mutationError).toBe('Ungültiges Datum.');
    });

    const p = useProjectStore.getState().projects[0]!;
    expect(p.plannedStart).toBe('2026-04-10');
    expect(p.plannedEnd).toBe('2026-04-12');
  });

  it('clears the date when null is passed', () => {
    mockedApi.updateDates.mockResolvedValue({ ok: true, data: makeProject() });
    useProjectStore.getState().updateDates('p1', null, undefined);
    expect(useProjectStore.getState().projects[0]!.plannedStart).toBeNull();
    expect(useProjectStore.getState().projects[0]!.plannedEnd).toBe('2026-04-12');
  });
});

describe('projectStore — queries', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [
        makeProject({ id: 'p1', status: 'anfrage' }),
        makeProject({ id: 'p2', status: 'anfrage' }),
        makeProject({ id: 'p3', status: 'in_arbeit' }),
      ],
    });
  });

  it('getProjectsByState filters to the requested state', () => {
    const anfrage = useProjectStore.getState().getProjectsByState('anfrage');
    expect(anfrage).toHaveLength(2);
    expect(anfrage.every((p) => p.status === 'anfrage')).toBe(true);

    const inArbeit = useProjectStore.getState().getProjectsByState('in_arbeit');
    expect(inArbeit).toHaveLength(1);
    expect(inArbeit[0]!.id).toBe('p3');
  });

  it('getSummary aggregates projects by state', () => {
    const summary = useProjectStore.getState().getSummary();
    // Verify the SummaryData shape (see domain/types.ts)
    expect(summary).toHaveProperty('actionCounts');
    expect(summary).toHaveProperty('agedBufferCounts');
    expect(summary).toHaveProperty('projectsWithoutDates');
    // Two projects in the action state 'anfrage'
    expect(summary.actionCounts.anfrage).toBe(2);
  });

  it('isMutationInFlight returns false for unknown ids', () => {
    expect(useProjectStore.getState().isMutationInFlight('nope')).toBe(false);
  });
});

describe('projectStore — clearMutationError', () => {
  it('clears any pending error', () => {
    useProjectStore.setState({ mutationError: 'Boom' });
    useProjectStore.getState().clearMutationError();
    expect(useProjectStore.getState().mutationError).toBeNull();
  });
});
