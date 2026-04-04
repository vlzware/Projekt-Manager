import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCollapseTier } from '../useCollapseTier';

function mockViewportWidth(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const maxWidthMatch = query.match(/max-width:\s*(\d+)px/);
    const maxWidth = maxWidthMatch ? Number(maxWidthMatch[1]) : 0;
    return {
      matches: width <= maxWidth,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCollapseTier', () => {
  it('returns 0 (no collapse) at viewport >= 1400px', () => {
    mockViewportWidth(1500);
    const { result } = renderHook(() => useCollapseTier());
    expect(result.current).toBe(0);
  });

  it('returns 3 (tier-3 collapse) at viewport < 1400px', () => {
    mockViewportWidth(1300);
    const { result } = renderHook(() => useCollapseTier());
    expect(result.current).toBe(3);
  });

  it('returns 2 (tier-2 collapse) at viewport < 1100px', () => {
    mockViewportWidth(1000);
    const { result } = renderHook(() => useCollapseTier());
    expect(result.current).toBe(2);
  });

  it('returns 1 (all collapse) at viewport < 900px', () => {
    mockViewportWidth(800);
    const { result } = renderHook(() => useCollapseTier());
    expect(result.current).toBe(1);
  });

  it('returns correct tier at exact breakpoint boundaries', () => {
    mockViewportWidth(1400);
    const { result: r1400 } = renderHook(() => useCollapseTier());
    expect(r1400.current).toBe(3);

    vi.restoreAllMocks();
    mockViewportWidth(1100);
    const { result: r1100 } = renderHook(() => useCollapseTier());
    expect(r1100.current).toBe(2);

    vi.restoreAllMocks();
    mockViewportWidth(900);
    const { result: r900 } = renderHook(() => useCollapseTier());
    expect(r900.current).toBe(1);
  });
});
