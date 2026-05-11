/**
 * Concurrent list-fetch correctness for `customerStore.fetchCustomers`
 * and `projectManagementStore.fetchProjects`:
 *
 *   1. The store's current `search` / `sortBy` / `sortDir` (and the
 *      project-store's `showArchived` / `assignedWorkerIds` /
 *      `includeUnassigned`) are forwarded to the API on every fetch.
 *      This is the contract behind "filters preserved across refetch"
 *      — SSE-driven and post-mutation refreshes read state, not
 *      defaults, so the user's current view survives.
 *
 *   2. When a second fetch is issued before the first resolves, the
 *      older response is dropped. Without the monotonic guard, a slow
 *      stale response would overwrite a fresher list — the exact bug
 *      that drove the store-lifting refactor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiResult } from '@/api/client';

const customerListMock = vi.fn();
const projectListMock = vi.fn();

vi.mock('@/api/client', () => ({
  authApi: { me: vi.fn(), login: vi.fn(), logout: vi.fn() },
  projectApi: {
    list: (...args: unknown[]) => projectListMock(...args),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    purge: vi.fn(),
    restore: vi.fn(),
    updateDates: vi.fn(),
    transitionForward: vi.fn(),
    transitionBackward: vi.fn(),
    get: vi.fn(),
  },
  customerApi: {
    list: (...args: unknown[]) => customerListMock(...args),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
  },
  workerApi: { list: vi.fn() },
  userApi: { list: vi.fn() },
}));

const { useCustomerStore } = await import('@/state/customerStore');
const { useProjectManagementStore } = await import('@/state/projectManagementStore');

beforeEach(() => {
  customerListMock.mockReset();
  projectListMock.mockReset();
  useCustomerStore.setState({
    customers: [],
    total: 0,
    error: null,
    loading: false,
    search: '',
    sortBy: 'name',
    sortDir: 'asc',
  });
  useProjectManagementStore.setState({
    projects: [],
    error: null,
    loading: false,
    showArchived: false,
    assignedWorkerIds: [],
    includeUnassigned: false,
    search: '',
    sortBy: null,
    sortDir: 'asc',
  });
});

describe('customerStore.fetchCustomers — preserves view state across refetch', () => {
  it('forwards current search/sortBy/sortDir from store state to the API', async () => {
    customerListMock.mockResolvedValue({
      ok: true,
      data: { customers: [], total: 0 },
    } satisfies ApiResult<{ customers: never[]; total: number }>);

    useCustomerStore.setState({ search: 'Müller', sortBy: 'city', sortDir: 'desc' });
    await useCustomerStore.getState().fetchCustomers();

    expect(customerListMock).toHaveBeenCalledTimes(1);
    expect(customerListMock).toHaveBeenCalledWith({
      search: 'Müller',
      sortBy: 'city',
      sortDir: 'desc',
    });
  });

  it('always forwards the explicit sort baseline (sortBy=name, sortDir=asc) even on empty search', async () => {
    customerListMock.mockResolvedValue({ ok: true, data: { customers: [], total: 0 } });

    await useCustomerStore.getState().fetchCustomers();

    expect(customerListMock).toHaveBeenCalledWith({ sortBy: 'name', sortDir: 'asc' });
  });

  it('drops whitespace-only search from the API call', async () => {
    customerListMock.mockResolvedValue({ ok: true, data: { customers: [], total: 0 } });

    useCustomerStore.setState({ search: '   ' });
    await useCustomerStore.getState().fetchCustomers();

    expect(customerListMock).toHaveBeenCalledWith({ sortBy: 'name', sortDir: 'asc' });
  });
});

describe('customerStore.fetchCustomers — drops superseded responses', () => {
  it('discards an older response that arrives after a newer fetch has resolved', async () => {
    // Two fetches: the FIRST is held until after the second resolves, so
    // its (stale) data must not clobber the fresh list.
    let resolveFirst: (
      v: ApiResult<{ customers: { id: string; name: string }[]; total: number }>,
    ) => void;
    const firstPromise = new Promise<
      ApiResult<{ customers: { id: string; name: string }[]; total: number }>
    >((resolve) => {
      resolveFirst = resolve;
    });
    customerListMock.mockReturnValueOnce(firstPromise).mockResolvedValueOnce({
      ok: true,
      data: { customers: [{ id: 'fresh-1', name: 'Fresh' }], total: 1 },
    });

    const first = useCustomerStore.getState().fetchCustomers();
    const second = useCustomerStore.getState().fetchCustomers();

    // Second resolves first — fresh data lands.
    await second;
    expect(useCustomerStore.getState().customers).toEqual([{ id: 'fresh-1', name: 'Fresh' }]);
    expect(useCustomerStore.getState().total).toBe(1);

    // Now resolve the older fetch with stale data. The store must reject it.
    resolveFirst!({
      ok: true,
      data: { customers: [{ id: 'stale-1', name: 'Stale' }], total: 1 },
    });
    await first;

    expect(useCustomerStore.getState().customers).toEqual([{ id: 'fresh-1', name: 'Fresh' }]);
    expect(useCustomerStore.getState().total).toBe(1);
  });

  it('does not flash an error from a superseded failing fetch', async () => {
    let resolveFirst: (v: ApiResult<{ customers: never[]; total: number }>) => void;
    const firstPromise = new Promise<ApiResult<{ customers: never[]; total: number }>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    customerListMock
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({ ok: true, data: { customers: [], total: 0 } });

    const first = useCustomerStore.getState().fetchCustomers();
    const second = useCustomerStore.getState().fetchCustomers();
    await second;

    // Older fetch fails after the newer one succeeded — error must not surface.
    resolveFirst!({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'stale-failure' },
      category: 'server_error',
      sessionExpired: false,
    });
    await first;

    expect(useCustomerStore.getState().error).toBeNull();
  });
});

describe('projectManagementStore.fetchProjects — preserves view state across refetch', () => {
  it('forwards search/sort/showArchived/assignedWorkerIds/includeUnassigned to the API', async () => {
    projectListMock.mockResolvedValue({ ok: true, data: { data: [], total: 0 } });

    useProjectManagementStore.setState({
      search: 'Fassade',
      sortBy: 'title',
      sortDir: 'desc',
      showArchived: true,
      assignedWorkerIds: ['u-1', 'u-2'],
      includeUnassigned: true,
    });
    await useProjectManagementStore.getState().fetchProjects();

    expect(projectListMock).toHaveBeenCalledTimes(1);
    expect(projectListMock).toHaveBeenCalledWith({
      search: 'Fassade',
      sortBy: 'title',
      sortDir: 'desc',
      includeArchived: true,
      assignedWorkerIds: ['u-1', 'u-2'],
      includeUnassigned: true,
    });
  });

  it('omits sort params when sortBy is null (historical default order)', async () => {
    projectListMock.mockResolvedValue({ ok: true, data: { data: [], total: 0 } });

    await useProjectManagementStore.getState().fetchProjects();

    expect(projectListMock).toHaveBeenCalledWith(undefined);
  });

  it('drops whitespace-only search from the API call', async () => {
    projectListMock.mockResolvedValue({ ok: true, data: { data: [], total: 0 } });

    useProjectManagementStore.setState({ search: '   ' });
    await useProjectManagementStore.getState().fetchProjects();

    expect(projectListMock).toHaveBeenCalledWith(undefined);
  });
});

describe('projectManagementStore.fetchProjects — drops superseded responses', () => {
  it('discards an older response that arrives after a newer fetch has resolved', async () => {
    let resolveFirst: (v: ApiResult<{ data: { id: string }[]; total: number }>) => void;
    const firstPromise = new Promise<ApiResult<{ data: { id: string }[]; total: number }>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    projectListMock
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({ ok: true, data: { data: [{ id: 'fresh-1' }], total: 1 } });

    const first = useProjectManagementStore.getState().fetchProjects();
    const second = useProjectManagementStore.getState().fetchProjects();

    await second;
    expect(useProjectManagementStore.getState().projects).toEqual([{ id: 'fresh-1' }]);

    resolveFirst!({ ok: true, data: { data: [{ id: 'stale-1' }], total: 1 } });
    await first;

    expect(useProjectManagementStore.getState().projects).toEqual([{ id: 'fresh-1' }]);
  });
});
