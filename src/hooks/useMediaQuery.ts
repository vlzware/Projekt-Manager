/**
 * Subscribe to a CSS media-query and re-render on transitions.
 *
 * Returns the current match boolean. SSR-safe via the `false` initial
 * value — the first paint matches the desktop branch, then the post-
 * mount listener drives any re-render. The project is a SPA so SSR is
 * not a concern today, but the guard keeps the hook reusable in a
 * potential future SSR shell without a refactor.
 */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
