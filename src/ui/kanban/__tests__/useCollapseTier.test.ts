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
  it('returns 0 (no collapse) at viewport >= 1780px', () => {
    mockViewportWidth(1900);
    const { result } = renderHook(() => useCollapseTier());
    expect(result.current).toBe(0);
  });

  it('returns 3 (tier-3 collapse) at viewport < 1780px', () => {
    mockViewportWidth(1700);
    const { result } = renderHook(() => useCollapseTier());
    expect(result.current).toBe(3);
  });

  it('returns 2 (tier-2 collapse) at viewport < 1350px', () => {
    mockViewportWidth(1200);
    const { result } = renderHook(() => useCollapseTier());
    expect(result.current).toBe(2);
  });

  it('returns 1 (all collapse) at viewport < 940px', () => {
    mockViewportWidth(900);
    const { result } = renderHook(() => useCollapseTier());
    expect(result.current).toBe(1);
  });

  // AC-28/29/30: exact breakpoint boundaries
  it('returns correct tier at exact breakpoint boundaries', () => {
    mockViewportWidth(1780);
    const { result: r1780 } = renderHook(() => useCollapseTier());
    expect(r1780.current).toBe(3);

    vi.restoreAllMocks();
    mockViewportWidth(1350);
    const { result: r1350 } = renderHook(() => useCollapseTier());
    expect(r1350.current).toBe(2);

    vi.restoreAllMocks();
    mockViewportWidth(940);
    const { result: r940 } = renderHook(() => useCollapseTier());
    expect(r940.current).toBe(1);
  });
});
