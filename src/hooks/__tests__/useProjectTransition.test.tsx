/**
 * useProjectTransition tests — covers canForward/canBackward, the
 * confirmation flow (via the confirm store), and the inFlight short-circuit.
 *
 * The hook is tested via @testing-library/react renderHook so we exercise
 * the real React lifecycle (not just the bare function).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Project } from '@/domain/types';

const transitionForwardMock = vi.fn();
const transitionBackwardMock = vi.fn();
let mockMutationInFlight: Record<string, boolean> = {};

vi.mock('@/state/projectStore', () => ({
  useProjectStore: <T,>(selector: (state: unknown) => T): T => {
    return selector({
      transitionForward: transitionForwardMock,
      transitionBackward: transitionBackwardMock,
      mutationInFlight: mockMutationInFlight,
    });
  },
}));

const confirmRequestMock = vi.fn();
vi.mock('@/state/confirmStore', () => ({
  useConfirmStore: {
    getState: () => ({ request: confirmRequestMock }),
  },
}));

import { useProjectTransition } from '@/hooks/useProjectTransition';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    number: '2026-001',
    title: 'Test',
    status: 'geplant',
    statusChangedAt: '2026-04-01T10:00:00.000Z',
    customer: { name: 'Test' },
    createdAt: '2026-03-30T10:00:00.000Z',
    updatedAt: '2026-03-30T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMutationInFlight = {};
  // Default: user confirms
  confirmRequestMock.mockResolvedValue(true);
});

describe('useProjectTransition — canForward / canBackward', () => {
  it('allows forward but not backward at the first state (anfrage)', () => {
    const { result } = renderHook(() => useProjectTransition(makeProject({ status: 'anfrage' })));
    expect(result.current.canForward).toBe(true);
    expect(result.current.canBackward).toBe(false);
  });

  it('allows both directions in the middle of the workflow', () => {
    const { result } = renderHook(() =>
      useProjectTransition(makeProject({ status: 'in_arbeit' })),
    );
    expect(result.current.canForward).toBe(true);
    expect(result.current.canBackward).toBe(true);
  });

  it('allows neither direction at the terminal state (erledigt)', () => {
    const { result } = renderHook(() => useProjectTransition(makeProject({ status: 'erledigt' })));
    expect(result.current.canForward).toBe(false);
    expect(result.current.canBackward).toBe(false);
  });
});

describe('useProjectTransition — forward', () => {
  it('asks for confirmation, then dispatches transitionForward when confirmed', async () => {
    const { result } = renderHook(() => useProjectTransition(makeProject({ status: 'geplant' })));

    await act(async () => {
      await result.current.forward();
    });

    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(confirmRequestMock).toHaveBeenCalledWith(expect.stringContaining('Geplant'));
    expect(transitionForwardMock).toHaveBeenCalledWith('p1');
  });

  it('does not dispatch when the user cancels the confirmation', async () => {
    confirmRequestMock.mockResolvedValue(false);
    const { result } = renderHook(() => useProjectTransition(makeProject({ status: 'geplant' })));

    await act(async () => {
      await result.current.forward();
    });

    expect(transitionForwardMock).not.toHaveBeenCalled();
  });

  it('short-circuits when a mutation is already in flight', async () => {
    mockMutationInFlight = { p1: true };
    const { result } = renderHook(() => useProjectTransition(makeProject({ status: 'geplant' })));

    await act(async () => {
      await result.current.forward();
    });

    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(transitionForwardMock).not.toHaveBeenCalled();
  });

  it('does nothing when the project has no next state', async () => {
    const { result } = renderHook(() => useProjectTransition(makeProject({ status: 'erledigt' })));

    await act(async () => {
      await result.current.forward();
    });

    expect(confirmRequestMock).not.toHaveBeenCalled();
    expect(transitionForwardMock).not.toHaveBeenCalled();
  });
});

describe('useProjectTransition — backward', () => {
  it('asks for confirmation, then dispatches transitionBackward when confirmed', async () => {
    const { result } = renderHook(() =>
      useProjectTransition(makeProject({ status: 'in_arbeit' })),
    );

    await act(async () => {
      await result.current.backward();
    });

    expect(confirmRequestMock).toHaveBeenCalledTimes(1);
    expect(transitionBackwardMock).toHaveBeenCalledWith('p1');
  });

  it('short-circuits when a mutation is already in flight', async () => {
    mockMutationInFlight = { p1: true };
    const { result } = renderHook(() =>
      useProjectTransition(makeProject({ status: 'in_arbeit' })),
    );

    await act(async () => {
      await result.current.backward();
    });

    expect(transitionBackwardMock).not.toHaveBeenCalled();
  });

  it('does nothing for the first state (no previous)', async () => {
    const { result } = renderHook(() => useProjectTransition(makeProject({ status: 'anfrage' })));

    await act(async () => {
      await result.current.backward();
    });

    expect(transitionBackwardMock).not.toHaveBeenCalled();
  });
});
