import { useState, useEffect } from 'react';
import type { CollapseTier } from '@/config/stateConfig';

const BREAKPOINTS: { maxWidth: number; tier: CollapseTier }[] = [
  { maxWidth: 900, tier: 1 },
  { maxWidth: 1100, tier: 2 },
  { maxWidth: 1400, tier: 3 },
];

/**
 * Returns the highest collapse tier that should be collapsed at the current viewport width.
 * - Returns 3 when viewport < 1400px (tier 3 columns collapse)
 * - Returns 2 when viewport < 1100px (tier 2 + 3 columns collapse)
 * - Returns 1 when viewport < 900px  (all columns collapse — action columns last)
 * - Returns 0 when viewport >= 1400px (nothing auto-collapses)
 */
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
