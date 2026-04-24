/**
 * Backup-freshness badge.
 *
 * Pure presentational component: consumes the already-derived
 * `BackupBadgeState` from `src/domain/backupBadge.ts`. The caller is
 * responsible for deriving the state (from `deriveBadgeState`) so this
 * component stays free of timing, thresholds, and data-shape knowledge
 * — it just maps a kind+reason to a visible label and a color cue.
 *
 * Shape: a fixed-size server-with-arrow icon that always occupies the
 * same pixel footprint in the header (previously alternated between a
 * bare dot in the healthy case and a full pill when degraded — the
 * size change read as a button that wasn't clickable and drew the eye
 * away from the affordance row on phones). Colour is the only signal
 * carrying state: green (healthy), amber (drill stale), red (action
 * required), muted (unknown).
 *
 * Spec pins ([verification.md §15.22](../../../docs/spec/verification.md#1522-backup-and-recovery)):
 *   - AC-170 — rendered on the owner's landing view only (not on the
 *     login screen, not on other roles' surfaces). Caller gates the
 *     render; this component renders unconditionally when asked.
 *   - AC-171 — never silently hidden; an `unknown` state still paints
 *     the icon in the muted colour and carries "Status unbekannt" in
 *     the tooltip / aria-label, so an unreachable status source is
 *     discoverable by hover and announced to assistive tech.
 *
 * Accessibility: the container carries `role="status"` so screen readers
 * announce the state when it changes. The label is the announced text
 * via `aria-label` (the icon is decorative — `aria-hidden` on the SVG).
 *
 * Colours consume the semantic token chain (`--color-success`, etc.)
 * via the CSS module so a theme override in tokens.css flows through
 * without touching this file.
 */
import type { BackupBadgeState } from '@/domain/backupBadge';
import { STRINGS } from '@/config/strings';
import styles from './BackupBadge.module.css';

interface BackupBadgeProps {
  state: BackupBadgeState;
  /**
   * Surface context. The header consumer passes `inverse` so the icon
   * tint reads against the dark header frame. The default light variant
   * is kept for any future caller on a light surface.
   */
  variant?: 'default' | 'inverse';
}

/**
 * German label for a derived state. Centralized via `STRINGS.backup` so
 * the reason-string union from `deriveBadgeState` drives the visible
 * copy rather than a parallel table that could drift. Exhaustive over
 * the union — adding a new reason in the domain will surface here as a
 * compile error via the `never` branch.
 */
function labelForRedReason(reason: Extract<BackupBadgeState, { kind: 'red' }>['reason']): string {
  switch (reason) {
    case 'backup-stale':
      return STRINGS.backup.backupStale;
    case 'last-run-failed':
      return STRINGS.backup.lastRunFailed;
    case 'backup-never-run':
      return STRINGS.backup.backupNeverRun;
    case 'drill-never-run':
      return STRINGS.backup.drillNeverRun;
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled backup-badge reason: ${String(_exhaustive)}`);
    }
  }
}

function labelFor(state: BackupBadgeState): string {
  switch (state.kind) {
    case 'unknown':
      return STRINGS.backup.unknown;
    case 'green':
      return STRINGS.backup.green;
    case 'amber':
      return STRINGS.backup.drillStale;
    case 'red':
      return labelForRedReason(state.reason);
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unhandled backup-badge state: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Map the discriminated `kind` to a CSS-module class so the icon tint
 * consumes the semantic token chain (danger / warning / success /
 * muted). Kept here rather than inline so theme overrides via tokens.css
 * flow through without touching this file.
 */
function stateClassFor(state: BackupBadgeState): string {
  switch (state.kind) {
    case 'green':
      return styles.stateGreen;
    case 'amber':
      return styles.stateAmber;
    case 'red':
      return styles.stateRed;
    case 'unknown':
      return styles.stateUnknown;
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unhandled backup-badge state: ${String(_exhaustive)}`);
    }
  }
}

export function BackupBadge({ state, variant = 'default' }: BackupBadgeProps) {
  const label = labelFor(state);
  const stateClass = stateClassFor(state);
  const surfaceClass = variant === 'inverse' ? styles.badgeInverse : '';

  return (
    <span
      className={`${styles.badge} ${stateClass} ${surfaceClass}`.trim()}
      data-testid="backup-badge"
      data-badge-kind={state.kind}
      role="status"
      title={label}
      aria-label={label}
    >
      {/* Database-stack + circular arrow — "database backup" glyph.
          `fill: currentColor` in CSS lets the colour follow the state
          class, so the same SVG renders in success/warning/danger/muted
          without per-variant art. */}
      <svg
        className={styles.icon}
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
      >
        <ellipse cx="9" cy="5" rx="6" ry="2" />
        <path d="M3 5v4c0 1.1 2.7 2 6 2s6-.9 6-2V5" />
        <path d="M3 9v4c0 1.1 2.7 2 6 2s6-.9 6-2V9" />
        <path d="M3 13v4c0 1.1 2.7 2 6 2 .7 0 1.4 0 2-.1" />
        <path
          d="M14 14a4 4 0 1 1 4 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15 21h3v-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
