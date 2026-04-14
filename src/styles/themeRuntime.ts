/*
 * Runtime theme subscription.
 *
 * The inline FOUC script in index.html handles the first paint. Once the
 * module graph boots, this runtime keeps the applied scheme in sync with:
 *   - OS color-scheme changes, when preference is 'system' (spec §9.6).
 *   - Cross-tab updates to the preference via the storage event.
 *
 * The inline script is intentionally import-free; this module duplicates a
 * minimal resolver rather than sharing code.
 */

import {
  THEME_PREFERENCE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from '../config/themeStorage';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

function readPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // localStorage may throw in private-browsing or sandboxed contexts.
  }
  return 'system';
}

function resolveScheme(pref: ThemePreference, mql: MediaQueryList | null): ResolvedTheme {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return mql?.matches ? 'dark' : 'light';
}

function applyScheme(scheme: ResolvedTheme): void {
  if (scheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

export function startThemeRuntime(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const mql = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_SCHEME_QUERY) : null;

  const reapply = (): void => {
    applyScheme(resolveScheme(readPreference(), mql));
  };

  if (mql) {
    // Only 'system' preference should react to OS changes; the resolver
    // handles that gating, so we can attach unconditionally.
    mql.addEventListener('change', reapply);
  }

  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === THEME_PREFERENCE_KEY || event.key === null) reapply();
  });
}
