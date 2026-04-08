/**
 * useRouterNav tests — pure helpers + the no-router fallback variant
 * (the React Router variant is exercised end-to-end by component tests
 * that mount <BrowserRouter>).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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
