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
 *   - AC-170 — rendered on the owner's landing view only (not on the
 *     login screen, not on other roles' surfaces). Severity-scaled
 *     presentation: green is a bare dot with a tooltip; amber, red,
 *     and unknown render as a full pill with label.
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
   * Surface context. Today the only consumer is the owner's landing
   * header (dark inverse-surface frame). The light variant is kept as
   * a default so a future caller on a light surface paints legibly
   * without a prop.
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
  // Severity-scaled presentation: green is the silent default — render
  // only the dot + tooltip so it doesn't compete with active surfaces
  // for attention. Amber / red / unknown stay loud (full pill with
  // label) because those states require operator action.
  const compact = state.kind === 'green';

  return (
    <div
      className={`${styles.badge} ${compact ? styles.badgeCompact : ''} ${surfaceClass}`.trim()}
      data-testid="backup-badge"
      data-badge-kind={state.kind}
      role="status"
      title={label}
      aria-label={label}
    >
      <span className={`${styles.indicator} ${indicatorClass}`} aria-hidden="true" />
      {!compact && <span className={styles.label}>{label}</span>}
    </div>
  );
}
