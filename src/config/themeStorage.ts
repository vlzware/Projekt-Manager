/*
 * Public contract for the client-side theme preference cache.
 *
 * THEME_PREFERENCE_KEY is pinned by spec §9.6 "Local cache semantics" and
 * the e2e contract in e2e/theming.spec.ts. Changing it requires a spec
 * change in docs/spec/ui/behavior.md and a coordinated test update.
 */

export const THEME_PREFERENCE_KEY = 'theme-preference';

export type ThemePreference = 'light' | 'dark' | 'system';

export type ResolvedTheme = 'light' | 'dark';
