/**
 * useRouterNav tests — pure helpers, the no-router fallback variant,
 * and the React Router variant (mounted with a MemoryRouter wrapper).
 */

import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { viewFromPath, pathFromView, useRouterNav } from '@/hooks/useRouterNav';
import { useUIStore } from '@/state/uiStore';

beforeEach(() => {
  useUIStore.setState({ ...useUIStore.getInitialState() });
});

describe('viewFromPath / pathFromView (pure helpers)', () => {
  it('maps known paths to their view modes', () => {
    expect(viewFromPath('/kanban')).toBe('kanban');
    expect(viewFromPath('/calendar')).toBe('kalender');
  });

  it('falls back to kanban for unknown paths', () => {
    expect(viewFromPath('/')).toBe('kanban');
    expect(viewFromPath('/projects/42')).toBe('kanban');
    expect(viewFromPath('')).toBe('kanban');
  });

  it('maps view modes back to canonical paths', () => {
    expect(pathFromView('kanban')).toBe('/kanban');
    expect(pathFromView('kalender')).toBe('/calendar');
  });

  it('round-trips: pathFromView ∘ viewFromPath is identity for known paths', () => {
    expect(pathFromView(viewFromPath('/kanban'))).toBe('/kanban');
    expect(pathFromView(viewFromPath('/calendar'))).toBe('/calendar');
  });
});

describe('useRouterNav — store fallback (no router context)', () => {
  it('reflects the active view from the store as pathname', () => {
    useUIStore.setState({ activeView: 'kanban' });
    const { result } = renderHook(() => useRouterNav());
    expect(result.current.pathname).toBe('/kanban');

    act(() => {
      useUIStore.getState().setView('kalender');
    });

    // Re-render the hook to pick up the new state
    const { result: result2 } = renderHook(() => useRouterNav());
    expect(result2.current.pathname).toBe('/calendar');
  });

  it('navigateTo updates the active view in the store', () => {
    const { result } = renderHook(() => useRouterNav());

    act(() => {
      result.current.navigateTo('/calendar');
    });

    expect(useUIStore.getState().activeView).toBe('kalender');
  });

  it('navigateTo to an unknown path falls back to kanban', () => {
    const { result } = renderHook(() => useRouterNav());

    act(() => {
      result.current.navigateTo('/some/unknown/route');
    });

    expect(useUIStore.getState().activeView).toBe('kanban');
  });

  it('navigateTo clears any active filter (matches uiStore.setView contract)', () => {
    useUIStore.setState({ activeFilter: 'rechnung_faellig' });
    const { result } = renderHook(() => useRouterNav());

    act(() => {
      result.current.navigateTo('/calendar');
    });

    expect(useUIStore.getState().activeFilter).toBeNull();
  });
});

describe('useRouterNav — router branch (with React Router context)', () => {
  const withRouter = (initialPath: string) => ({
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
    ),
  });

  it('reflects the router location as pathname when inside a MemoryRouter', () => {
    const { result } = renderHook(() => useRouterNav(), withRouter('/calendar'));
    expect(result.current.pathname).toBe('/calendar');
  });

  it('navigateTo routes via react-router — pathname updates to the new path', () => {
    const { result } = renderHook(() => useRouterNav(), withRouter('/kanban'));
    expect(result.current.pathname).toBe('/kanban');

    act(() => {
      result.current.navigateTo('/calendar');
    });

    // pathname comes from useLocation() — proves the router branch was taken
    // and the navigate() call actually updated the router's location.
    expect(result.current.pathname).toBe('/calendar');
  });

  it('navigateTo also syncs uiStore.activeView (pre-empting the URL→store effect)', () => {
    useUIStore.setState({ activeView: 'kanban' });
    const { result } = renderHook(() => useRouterNav(), withRouter('/kanban'));

    act(() => {
      result.current.navigateTo('/calendar');
    });

    expect(useUIStore.getState().activeView).toBe('kalender');
  });

  it('navigateTo to an unknown path falls back to kanban in the uiStore sync', () => {
    useUIStore.setState({ activeView: 'kalender' });
    const { result } = renderHook(() => useRouterNav(), withRouter('/kanban'));

    act(() => {
      result.current.navigateTo('/some/unknown/route');
    });

    // Router moves to the unknown path, but the store sync maps unknown → kanban.
    expect(result.current.pathname).toBe('/some/unknown/route');
    expect(useUIStore.getState().activeView).toBe('kanban');
  });
});
