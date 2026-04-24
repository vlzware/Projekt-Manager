/**
 * Layout breakpoints — single source of truth for responsive thresholds.
 *
 * Mirrored as `@media (max-width: …)` queries in CSS module files. The
 * narrow-mobile cutoff is 768 px today; below that, surfaces collapse
 * single-column and card taps deep-link rather than open the desktop
 * preview modal. Update both this constant and the matching CSS rules
 * together.
 */
export const BREAKPOINTS = {
  /** Phone / narrow tablet portrait. */
  md: 768,
} as const;
