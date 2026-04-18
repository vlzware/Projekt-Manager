/**
 * Unit tests for the backup-freshness badge derive-state function.
 *
 * Covers verification.md §15.22 AC-171 [crit]: misleading state is
 * a critical defect class (ADR-0014). The badge MUST render an
 * explicit "status unbekannt" surface when the status source is
 * unreachable, and MUST render the red / drill-stale state when
 * `lastDrillAt` is absent — never silently hidden, never a stale-
 * but-green reading.
 *
 * Pure-function test: no network, no DB, no React. The Phase 3
 * module exports a single function that takes a `BackupStatus` (or
 * a sentinel for "unreachable") and returns the derived badge
 * state. Rendering lives elsewhere — this test pins the semantic
 * mapping that rendering must follow.
 *
 * Module contract Phase 3 must provide:
 *
 *   src/domain/backupBadge.ts
 *     export type BackupBadgeState =
 *       | { kind: 'unknown'; label: string }
 *       | { kind: 'green' }
 *       | { kind: 'amber'; reason: 'drill-stale' }
 *       | { kind: 'red'; reason: 'backup-stale' | 'drill-never-run' | 'last-run-failed' };
 *     export interface BackupStatus {
 *       lastBackupAt?: string;
 *       lastBackupOk: boolean;
 *       lastDrillAt?: string;
 *       // Explicit null = "no Tier 2 drill has ever succeeded or
 *       // failed" (data-model.md §5.9). `undefined` is not a valid
 *       // variant — callers hand through the raw DB row.
 *       lastDrillOk: boolean | null;
 *       lastError?: string;
 *       updatedAt: string;
 *     }
 *     export interface BadgeThresholds {
 *       backupAmberDays: number;
 *       backupRedDays: number;
 *       drillAmberDays: number;
 *       drillRedDays: number;
 *     }
 *     export function deriveBadgeState(
 *       status: BackupStatus | undefined,
 *       now: Date,
 *       thresholds: BadgeThresholds,
 *     ): BackupBadgeState;
 *
 * `status === undefined` models the "unreachable" case (DB down AND
 * mirror not retrievable). Callers fetch both surfaces and pass
 * `undefined` only when neither yielded a row.
 */

import { describe, it, expect } from 'vitest';
import { deriveBadgeState, type BackupStatus, type BadgeThresholds } from '../backupBadge.js';

// Representative thresholds — real values ship as `[C]` via config
// (architecture.md §12.2). These numbers are local to the unit test
// and keep the assertions readable; production config supplies the
// real values at render time.
const THRESHOLDS: BadgeThresholds = {
  backupAmberDays: 2,
  backupRedDays: 4,
  drillAmberDays: 14,
  drillRedDays: 30,
};

const NOW = new Date('2026-04-17T12:00:00.000Z');

/** Helper: ISO string for `daysAgo` days before NOW. */
function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

describe('AC-171: backup badge — unreachable + never-drilled states', () => {
  it("renders 'Status unbekannt' when the status source is unreachable", () => {
    // `undefined` models the DB-down + mirror-unavailable branch.
    const s = deriveBadgeState(undefined, NOW, THRESHOLDS);
    expect(s.kind).toBe('unknown');
    if (s.kind === 'unknown') {
      // German UI string — AC-171 names the surface explicitly.
      // Case-insensitive match so the component is free to
      // sentence-case it during rendering.
      expect(s.label.toLowerCase()).toContain('status unbekannt');
    }
  });

  it('renders red / drill-never-run when lastDrillAt is absent and lastDrillOk is null', () => {
    // Backup is fresh, but no Tier 2 drill has ever run. AC-171 is
    // explicit that this is the red threshold, not amber, because
    // an unverified backup cycle is worse than a stale verified one.
    // `lastDrillOk: null` is the authoritative "never-run" signal per
    // data-model.md §5.9 — the badge MUST read the null value as a
    // distinct state rather than coerce it to `undefined`.
    const status: BackupStatus = {
      lastBackupOk: true,
      lastBackupAt: daysAgo(0),
      lastDrillAt: undefined,
      lastDrillOk: null,
      lastError: undefined,
      updatedAt: daysAgo(0),
    };
    const s = deriveBadgeState(status, NOW, THRESHOLDS);
    expect(s.kind).toBe('red');
    if (s.kind === 'red') {
      expect(s.reason).toBe('drill-never-run');
    }
  });

  it('never returns a silent/hidden state', () => {
    // Permutations: unreachable, never-drilled, last-run-failed, stale,
    // and fresh. Every permutation must produce a rendered badge state —
    // a `null`/`undefined` return is the forbidden misleading-state case.
    const cases: Array<BackupStatus | undefined> = [
      undefined,
      {
        lastBackupOk: true,
        lastBackupAt: daysAgo(0),
        lastDrillAt: undefined,
        lastDrillOk: null,
        lastError: undefined,
        updatedAt: daysAgo(0),
      },
      {
        lastBackupOk: false,
        lastBackupAt: daysAgo(1),
        lastDrillAt: daysAgo(1),
        lastDrillOk: false,
        lastError: 'last run failed',
        updatedAt: daysAgo(1),
      },
      {
        lastBackupOk: true,
        lastBackupAt: daysAgo(THRESHOLDS.backupRedDays + 1),
        lastDrillAt: daysAgo(THRESHOLDS.drillRedDays + 1),
        lastDrillOk: true,
        lastError: undefined,
        updatedAt: daysAgo(THRESHOLDS.backupRedDays + 1),
      },
      {
        lastBackupOk: true,
        lastBackupAt: daysAgo(0),
        lastDrillAt: daysAgo(0),
        lastDrillOk: true,
        lastError: undefined,
        updatedAt: daysAgo(0),
      },
    ];
    for (const c of cases) {
      const s = deriveBadgeState(c, NOW, THRESHOLDS);
      expect(s).toBeDefined();
      expect(s.kind).toMatch(/^(unknown|green|amber|red)$/);
    }
  });

  it('does not show green when the last run recorded a failure', () => {
    // Last run was within the fresh window, but `lastBackupOk === false`.
    // The badge must not read green on a failed run even if the
    // timestamp is recent. "Stale-but-green" is the misleading case
    // AC-171 explicitly forbids.
    const status: BackupStatus = {
      lastBackupOk: false,
      lastBackupAt: daysAgo(0),
      lastDrillAt: daysAgo(0),
      lastDrillOk: false,
      lastError: 'Tier 1 mismatch on projects',
      updatedAt: daysAgo(0),
    };
    const s = deriveBadgeState(status, NOW, THRESHOLDS);
    expect(s.kind).not.toBe('green');
  });

  it('renders red / backup-never-run when the pre-seed row is observed (no run has happened)', () => {
    // Migration 0001 pre-seeds the row with `lastBackupOk=false` AND a
    // null `last_backup_at`. That shape is semantically "no backup has
    // ever run" — it must NOT be conflated with "a real run failed",
    // which always carries a populated `lastBackupAt`. Distinct reason
    // strings so operators see a distinct cue.
    const status: BackupStatus = {
      lastBackupOk: false,
      lastBackupAt: undefined,
      lastDrillAt: undefined,
      lastDrillOk: null,
      lastError: undefined,
      updatedAt: daysAgo(0),
    };
    const s = deriveBadgeState(status, NOW, THRESHOLDS);
    expect(s.kind).toBe('red');
    if (s.kind === 'red') {
      expect(s.reason).toBe('backup-never-run');
    }
  });

  it('still renders last-run-failed (not never-run) when a real run has occurred and failed', () => {
    // The post-real-run failed shape MUST still fire `last-run-failed`.
    // Guard against a regression where the never-run branch accidentally
    // subsumes a genuinely-failed run (both carry `lastBackupOk=false`,
    // the distinguishing feature is `lastBackupAt` being set).
    const status: BackupStatus = {
      lastBackupOk: false,
      lastBackupAt: daysAgo(0),
      lastDrillAt: daysAgo(0),
      lastDrillOk: false,
      lastError: 'Tier 1 mismatch on projects',
      updatedAt: daysAgo(0),
    };
    const s = deriveBadgeState(status, NOW, THRESHOLDS);
    expect(s.kind).toBe('red');
    if (s.kind === 'red') {
      expect(s.reason).toBe('last-run-failed');
    }
  });
});
