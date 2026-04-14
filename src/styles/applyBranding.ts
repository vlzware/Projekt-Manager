/*
 * Brand accent injection.
 *
 * Reads the `[C]` brand accent from `src/config/brandingConfig.ts` and
 * writes it to the document root as two CSS custom properties:
 *   --brand-accent-light
 *   --brand-accent-dark
 *
 * The semantic accent chain (--color-accent, --color-accent-hover,
 * --color-accent-active-surface, --color-focus-ring) resolves through
 * these at runtime, with fallback defaults declared in tokens.css for
 * the pre-JS frame (see §12.5 of the architecture spec).
 *
 * Call this BEFORE `startThemeRuntime()` in `src/main.tsx`: the theme
 * cascade then resolves against an already-populated brand accent on
 * the same frame. The FOUC inline script in `index.html` deliberately
 * does NOT touch the brand accent — it runs before modules load and
 * would have no access to BRANDING. The tokens.css fallback covers the
 * sub-frame gap.
 *
 * Limitation: a deployment with a NON-default accent sees a single-
 * frame flash of the default accent before `applyBranding()` fires. A
 * build-time substitution into index.html would close this gap; it's
 * not done today because the flash is one frame on a non-theme-critical
 * surface (buttons, focus ring) and is invisible on the default-brand
 * config that this repo ships.
 */

import { BRANDING } from '../config/brandingConfig';

// Property names are pinned by AC-114 / e2e/theming.spec.ts. Do not rename.
const BRAND_ACCENT_LIGHT = '--brand-accent-light';
const BRAND_ACCENT_DARK = '--brand-accent-dark';

export function applyBranding(): void {
  // SSR / non-browser safety. The app is CSR-only today, but the guard is
  // cheap and keeps the module import-safe in test runners that stub the
  // DOM after module load.
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;

  root.style.setProperty(BRAND_ACCENT_LIGHT, BRANDING.accent.light);
  root.style.setProperty(BRAND_ACCENT_DARK, BRANDING.accent.dark);
}
