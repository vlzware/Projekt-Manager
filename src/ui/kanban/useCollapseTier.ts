import { useState, useEffect } from 'react';
import type { CollapseTier } from '@/config/stateConfig';

/*
 * Breakpoints derived from layout dimensions:
 *   column min-width: 185px, collapsed: 44px, gap: 8px, board padding: 2×12px
 *   9 expanded:           9×185 + 8×8 + 24 = 1753px → breakpoint 1780
 *   6 expanded + 3 coll:  6×185 + 3×44 + 8×8 + 24 = 1330px → breakpoint 1350
 *   3 expanded + 6 coll:  3×185 + 6×44 + 8×8 + 24 =  907px → breakpoint  940
 *   ~30px buffer biases toward early collapse (free space > horizontal scroll).
 */
const BREAKPOINTS: { maxWidth: number; tier: CollapseTier }[] = [
  { maxWidth: 940, tier: 1 },
  { maxWidth: 1350, tier: 2 },
  { maxWidth: 1780, tier: 3 },
];
export function useCollapseTier(): number {
  const [activeTier, setActiveTier] = useState(() => computeTier());

  useEffect(() => {
    const queries = BREAKPOINTS.map(({ maxWidth }) =>
      window.matchMedia(`(max-width: ${maxWidth}px)`),
    );

    const update = () => setActiveTier(computeTier());
    queries.forEach((mq) => mq.addEventListener('change', update));
    return () => queries.forEach((mq) => mq.removeEventListener('change', update));
  }, []);

  return activeTier;
}

function computeTier(): number {
  for (const { maxWidth, tier } of BREAKPOINTS) {
    if (window.matchMedia(`(max-width: ${maxWidth}px)`).matches) {
      return tier;
    }
  }
  return 0;
}
