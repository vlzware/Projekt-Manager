/**
 * Backup-freshness badge.
 *
 * Pure presentational component: consumes the already-derived
 * `BackupBadgeState` from `src/domain/backupBadge.ts`. The caller is
 * responsible for deriving the state (from `deriveBadgeState`) so this
 * component stays free of timing, thresholds, and data-shape knowledge
 * — it just maps a kind+reason to a visible label and a color cue.
 *
 * Spec pins ([verification.md §15.22](../../../docs/spec/verification.md#1522-backup-and-recovery)):
 *   - AC-170 — rendered on the login screen and on the owner landing only.
 *   - AC-171 — never silently hidden; `unknown` surfaces as "Status
 *     unbekannt" so an unreachable status source is explicit.
 *
 * Accessibility: the container carries `role="status"` so screen readers
 * announce the state when it changes. The label itself is the announced
 * text — no aria-label override; the color indicator is decorative.
 *
 * Colors consume the semantic token chain (`--color-success`, etc.) so
 * a theme override in tokens.css flows through automatically.
 */
import type { BackupBadgeState } from '@/domain/backupBadge';
import { STRINGS } from '@/config/strings';
import styles from './BackupBadge.module.css';

interface BackupBadgeProps {
  state: BackupBadgeState;
  /**
   * Surface context. The owner landing header sits on the dark
   * inverse-surface frame; the login screen sits on the light
   * raised-surface frame. The default matches the login surface so a
   * caller that forgets the prop still paints legibly.
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
 * Map the discriminated `kind` to a CSS-module class so the color cue
 * consumes the semantic token chain (danger / warning / success /
 * muted). Kept here rather than inline so theme overrides via tokens.css
 * flow through without touching this file.
 */
function indicatorClassFor(state: BackupBadgeState): string {
  switch (state.kind) {
    case 'green':
      return styles.indicatorGreen;
    case 'amber':
      return styles.indicatorAmber;
    case 'red':
      return styles.indicatorRed;
    case 'unknown':
      return styles.indicatorUnknown;
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unhandled backup-badge state: ${String(_exhaustive)}`);
    }
  }
}

export function BackupBadge({ state, variant = 'default' }: BackupBadgeProps) {
  const label = labelFor(state);
  const indicatorClass = indicatorClassFor(state);
  const surfaceClass = variant === 'inverse' ? styles.badgeInverse : '';

  return (
    <div
      className={`${styles.badge} ${surfaceClass}`.trim()}
      data-testid="backup-badge"
      data-badge-kind={state.kind}
      role="status"
    >
      <span className={`${styles.indicator} ${indicatorClass}`} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </div>
  );
}
