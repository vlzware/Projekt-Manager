/**
 * Component tests for ProjectManagement covering:
 *
 *   - Number preflight: blur triggers the lookup and the indicator
 *     switches to "taken" when a match is found, or "available" when
 *     not.
 *   - Editing the number after the verdict clears the indicator until
 *     the next blur.
 *   - The preflight does NOT block submission (server is authoritative).
 *
 * API client is stubbed; real stores run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiResult } from '@/api/client';
import type { Customer, Project } from '@/domain/types';

type ProjectListResult = ApiResult<{ data: Project[]; total: number }>;
type CustomerListResult = ApiResult<{ customers: Customer[]; total: number }>;

const projectListMock = vi.fn<() => Promise<ProjectListResult>>();
const customerListMock = vi.fn<() => Promise<CustomerListResult>>();

vi.mock('@/api/client', () => ({
  projectApi: {
    list: (...args: unknown[]) => projectListMock(...(args as Parameters<typeof projectListMock>)),
    create: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    updateDates: vi.fn(),
    transitionForward: vi.fn(),
    transitionBackward: vi.fn(),
  },
  customerApi: {
    list: (...args: unknown[]) =>
      customerListMock(...(args as Parameters<typeof customerListMock>)),
    create: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ ok: false }),
    login: vi.fn(),
    logout: vi.fn(),
  },
  userApi: { list: vi.fn() },
}));

const { ProjectManagement } = await import('@/ui/management/ProjectManagement');
const { useAuthStore } = await import('@/state/authStore');
const { useProjectManagementStore } = await import('@/state/projectManagementStore');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function mockProject(overrides: Partial<Project>): Project {
  return {
    id: 'p-1',
    number: 'P-1',
    title: 't',
    status: 'anfrage',
    statusChangedAt: '2026-04-01T00:00:00Z',
    plannedStart: null,
    plannedEnd: null,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    customerId: 'c-1',
    customer: null,
    assignedWorkers: [],
    estimatedValue: null,
    notes: null,
    deleted: false,
    createdBy: null,
    updatedBy: null,
    ...overrides,
  } as Project;
}

beforeEach(() => {
  projectListMock.mockReset();
  customerListMock.mockReset();
  projectListMock.mockResolvedValue(ok({ data: [], total: 0 }));
  customerListMock.mockResolvedValue(ok({ customers: [], total: 0 }));
  useAuthStore.setState({
    authUser: {
      id: 'u-1',
      username: 'owner',
      displayName: 'Owner',
      roles: ['owner'],
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });
  useProjectManagementStore.setState({
    projects: [],
    customers: [],
    loading: false,
    error: null,
  });
});

function renderWithRouter(ui: ReactElement): ReturnType<typeof render> {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ProjectManagement — number preflight', () => {
  it('shows "taken" on blur when the number already exists', async () => {
    projectListMock.mockImplementation(async (params?: { search?: string }) => {
      if (params?.search === 'P-99') {
        return ok({ data: [mockProject({ id: 'p-99', number: 'P-99' })], total: 1 });
      }
      return ok({ data: [], total: 0 });
    });

    renderWithRouter(<ProjectManagement />);

    await userEvent.click(screen.getByTestId('project-create-button'));
    const numberInput = screen.getByTestId('project-number-input');
    await userEvent.type(numberInput, 'P-99');
    fireEvent.blur(numberInput);

    const taken = await screen.findByTestId('project-number-taken');
    expect(taken.textContent).toContain('P-99');
    expect(screen.queryByTestId('project-number-available')).not.toBeInTheDocument();
  });

  it('shows "available" on blur when the number is free', async () => {
    renderWithRouter(<ProjectManagement />);

    await userEvent.click(screen.getByTestId('project-create-button'));
    const numberInput = screen.getByTestId('project-number-input');
    await userEvent.type(numberInput, 'P-1000');
    fireEvent.blur(numberInput);

    await screen.findByTestId('project-number-available');
    expect(screen.queryByTestId('project-number-taken')).not.toBeInTheDocument();
  });

  it('clears the indicator when the number changes after blur', async () => {
    projectListMock.mockImplementation(async (params?: { search?: string }) => {
      if (params?.search === 'P-99') {
        return ok({ data: [mockProject({ id: 'p-99', number: 'P-99' })], total: 1 });
      }
      return ok({ data: [], total: 0 });
    });

    renderWithRouter(<ProjectManagement />);

    await userEvent.click(screen.getByTestId('project-create-button'));
    const numberInput = screen.getByTestId('project-number-input');
    await userEvent.type(numberInput, 'P-99');
    fireEvent.blur(numberInput);
    await screen.findByTestId('project-number-taken');

    // Any edit after blur clears the verdict until next blur.
    await userEvent.type(numberInput, 'X');
    await waitFor(() => {
      expect(screen.queryByTestId('project-number-taken')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('project-number-available')).not.toBeInTheDocument();
  });

  it('ignores a stale preflight response when a newer blur supersedes it', async () => {
    // Two pending promises, resolved out of order. The first blur
    // queries 'P-99' (would show 'taken'); the second blur queries
    // 'P-FREE' (would show 'available'). If the monotonic guard works
    // only the second result is committed, even though the first
    // resolves last.
    const deferredTaken = withDeferred<{ data: Project[]; total: number }>();
    const deferredFree = withDeferred<{ data: Project[]; total: number }>();

    projectListMock.mockImplementation((params?: { search?: string }) => {
      if (params?.search === 'P-99') return deferredTaken.promise.then(ok);
      if (params?.search === 'P-FREE') return deferredFree.promise.then(ok);
      return Promise.resolve(ok({ data: [], total: 0 }));
    });

    renderWithRouter(<ProjectManagement />);
    await userEvent.click(screen.getByTestId('project-create-button'));
    const numberInput = screen.getByTestId('project-number-input');

    await userEvent.type(numberInput, 'P-99');
    fireEvent.blur(numberInput);
    // Both API calls are now in flight (or at least, the first one is);
    // trigger the second blur after changing the value.
    await userEvent.clear(numberInput);
    await userEvent.type(numberInput, 'P-FREE');
    fireEvent.blur(numberInput);

    // Resolve out of order: the newer (P-FREE) first, then the stale
    // (P-99). The stale result must NOT overwrite the 'available'
    // verdict.
    deferredFree.resolve({ data: [], total: 0 });
    await screen.findByTestId('project-number-available');

    deferredTaken.resolve({
      data: [mockProject({ id: 'p-99', number: 'P-99' })],
      total: 1,
    });

    // Give the stale resolver time to (incorrectly) commit.
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.queryByTestId('project-number-taken')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-number-available')).toBeInTheDocument();
  });
});

function withDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
