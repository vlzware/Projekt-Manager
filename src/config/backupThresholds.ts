/**
 * Backup-freshness badge thresholds.
 *
 * Day-based age windows consumed by `deriveBadgeState` in
 * `src/domain/backupBadge.ts`. Two pairs:
 *   - backup age: amber when stale-but-fresh, red when stale-past-red.
 *   - drill age:  amber when verifier is late, red when severely late.
 *
 * All four values are [C] customer-configurable per architecture.md §12.2.
 * The defaults below are calibrated to the once-daily cadence described
 * in ADR-0020 (Layer 2 encrypted R2 backups with operator-loaded drills):
 *
 *   - backupAmberDays=2  — two missed cadence windows is noticeable but
 *     not alarming on its own (a maintenance pause is plausible).
 *   - backupRedDays=4    — four missed windows exceeds any ordinary
 *     maintenance pause; the backup cycle is functionally broken.
 *   - drillAmberDays=14  — two weeks without a Tier 2 verification is
 *     the point where the backup cycle is no longer known-restorable.
 *   - drillRedDays=30    — a month of drill silence is treated as no
 *     working restore path even if artifacts exist.
 *
 * A deployment that runs a different backup cadence overrides these
 * values per ADR-0001 customer-configuration pattern; the defaults here
 * are the build-time baseline, not a policy cap.
 *
 * Layer note: this module sits in the config layer, which cannot import
 * from `src/domain` (eslint CONFIG_BANNED). The shape is defined locally
 * and is structurally assignable to `BadgeThresholds` in
 * `src/domain/backupBadge.ts`; a compile-time smoke check in the client
 * consumer would catch any drift.
 */
export interface BackupThresholdsConfig {
  /** Age (days) at which a fresh-but-aging backup switches to amber. [C] */
  backupAmberDays: number;
  /** Age (days) at which a backup is considered red-stale. [C] */
  backupRedDays: number;
  /** Age (days) at which a fresh-but-aging drill switches to amber. [C] */
  drillAmberDays: number;
  /** Age (days) at which a drill is considered red-stale. [C] */
  drillRedDays: number;
}

/** [C] — customer-configurable; see module docstring for rationale. */
export const BACKUP_THRESHOLDS: BackupThresholdsConfig = {
  backupAmberDays: 2,
  backupRedDays: 4,
  drillAmberDays: 14,
  drillRedDays: 30,
};
