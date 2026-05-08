/**
 * projectSseSubscription — wires both project stores to refresh on
 * every `project_changed` SSE frame (api.md §14.2.13, AC-277).
 *
 * The unit-level contract (the AC-277 e2e is the value test):
 *   1. Subscribing registers a handler under the `project_changed`
 *      event name on the typed SSE bus (`@/sse/client`'s `onSseEvent`).
 *   2. Firing that handler calls `fetchProjects` on BOTH `useProjectStore`
 *      and `useProjectManagementStore` exactly once each. Two surfaces
 *      power different views (kanban / calendar / detail vs management
 *      list); both must refresh so the office observer's whichever
 *      surface is parked reflects the change.
 *   3. The returned unsubscribe handle removes the listener — a frame
 *      arriving after unsubscribe must not refetch.
 *   4. Repeated `subscribeProjectStoresToSse()` calls do not register
 *      multiple handlers (idempotency — a hot reload or a duplicate
 *      bootstrap must not produce double refetches per event).
 *
 * Mocks mirror `storageUsageStore.test.ts` shape: a typed-bus stub
 * exposes the registered handler so tests dispatch through it; the two
 * stores' `fetchProjects` are spied so the test asserts the fan-out
 * shape rather than the underlying API call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type SseHandler = () => void;
const sseHandlers = new Map<string, Set<SseHandler>>();
const onSseEventMock = vi.fn((name: string, handler: SseHandler): (() => void) => {
  let set = sseHandlers.get(name);
  if (!set) {
    set = new Set();
    sseHandlers.set(name, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
});

vi.mock('@/sse/client', () => ({
  onSseEvent: (name: string, handler: SseHandler) => onSseEventMock(name, handler),
}));

const projectStoreFetchMock = vi.fn(async () => {});
const projectManagementStoreFetchMock = vi.fn(async () => {});

vi.mock('@/state/projectStore', () => ({
  useProjectStore: {
    getState: () => ({ fetchProjects: projectStoreFetchMock }),
  },
}));

vi.mock('@/state/projectManagementStore', () => ({
  useProjectManagementStore: {
    getState: () => ({ fetchProjects: projectManagementStoreFetchMock }),
  },
}));

const { subscribeProjectStoresToSse, __resetProjectSseSubscriptionForTests } =
  await import('@/state/projectSseSubscription');

beforeEach(() => {
  onSseEventMock.mockClear();
  projectStoreFetchMock.mockClear();
  projectManagementStoreFetchMock.mockClear();
  sseHandlers.clear();
  __resetProjectSseSubscriptionForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('projectSseSubscription — wiring (AC-277)', () => {
  it('registers a handler for the project_changed event', () => {
    subscribeProjectStoresToSse();

    expect(onSseEventMock).toHaveBeenCalledTimes(1);
    expect(onSseEventMock).toHaveBeenCalledWith('project_changed', expect.any(Function));
  });

  it('refetches both stores exactly once per project_changed frame', () => {
    subscribeProjectStoresToSse();

    const handlers = sseHandlers.get('project_changed');
    expect(handlers && handlers.size).toBe(1);
    for (const h of handlers!) h();

    // Each surface refetches its own slice — kanban / detail via
    // useProjectStore, management list via useProjectManagementStore.
    expect(projectStoreFetchMock).toHaveBeenCalledTimes(1);
    expect(projectManagementStoreFetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops refetching after unsubscribe', () => {
    const unsubscribe = subscribeProjectStoresToSse();

    // Fire once — both stores refetch.
    const handlers = sseHandlers.get('project_changed');
    for (const h of handlers!) h();
    expect(projectStoreFetchMock).toHaveBeenCalledTimes(1);
    expect(projectManagementStoreFetchMock).toHaveBeenCalledTimes(1);

    unsubscribe();

    // Frame arriving after unsubscribe — the SSE bus mock removed the
    // handler from the set, so the for-of fans out to nothing.
    const handlersAfter = sseHandlers.get('project_changed');
    if (handlersAfter) {
      for (const h of handlersAfter) h();
    }
    expect(projectStoreFetchMock).toHaveBeenCalledTimes(1);
    expect(projectManagementStoreFetchMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: repeated subscribe calls register one handler, fan out once per frame', () => {
    subscribeProjectStoresToSse();
    subscribeProjectStoresToSse();
    subscribeProjectStoresToSse();

    expect(onSseEventMock).toHaveBeenCalledTimes(1);

    const handlers = sseHandlers.get('project_changed');
    expect(handlers && handlers.size).toBe(1);
    for (const h of handlers!) h();

    expect(projectStoreFetchMock).toHaveBeenCalledTimes(1);
    expect(projectManagementStoreFetchMock).toHaveBeenCalledTimes(1);
  });
});
