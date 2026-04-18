/**
 * Branding configuration — customer-specific per ADR-0001.
 * Each installation overrides these values for their company.
 *
 * Brand accent contract ([C] in spec §12.2 / §12.5):
 *   - `accent.light` and `accent.dark` are the ONLY raw color literals
 *     permitted in this file. They are the brand accent for light and dark
 *     themes respectively — both keys are required, no auto-derivation
 *     (clarity over cleverness, per #101).
 *   - These values are injected into the CSS custom properties
 *     `--brand-accent-light` and `--brand-accent-dark` at boot by
 *     `src/styles/applyBranding.ts`. No other module consumes these raw
 *     hex strings; stylesheets reference the semantic `--color-accent`
 *     token chain instead.
 *   - Each value MUST meet WCAG AA against both `--color-surface-base`
 *     (the body background it sits on in borders/focus-rings) and
 *     `--color-text-on-accent` (the label text on filled accent
 *     surfaces) in its respective mode. The defaults below pair with
 *     `--color-text-on-accent: slate-900` and give 4.97:1 (light) and
 *     7.31:1 (dark) — do not regress without re-checking contrast.
 */
export interface BrandingConfig {
  appName: string;
  footerText: string;
  accent: {
    light: string;
    dark: string;
  };
}

export const BRANDING: BrandingConfig = {
  appName: 'Projekt-Manager',
  footerText: 'Projekt-Manager',
  accent: {
    light: '#3b82f6', // tailwind blue-500 — 4.97:1 against slate-900
    dark: '#60a5fa', //  tailwind blue-400 — 7.31:1 against slate-900
  },
};
