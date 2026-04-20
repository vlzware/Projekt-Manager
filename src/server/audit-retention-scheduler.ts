/**
 * Periodic audit-log retention cleanup scheduler.
 *
 * Mirrors `session-reaper.ts`: setInterval sweep, unref'd handle,
 * never-propagate sweep errors, stop() awaits any in-flight run so
 * graceful shutdown doesn't tear down the pg pool mid-query.
 *
 * Separate from the session reaper because:
 *   - cadence differs (reaper = minutes; retention = daily by default);
 *   - log shape differs (reaper = `info(msg: string)`; retention =
 *     `ServiceLogger.info(ctx, event)` per AC-184);
 *   - the failure-counter state is per-job by design — a sustained
 *     session-reap failure should not silence retention, and vice
 *     versa.
 *
 * Sustained-failure handling parallels the reaper: after three
 * consecutive sweep failures emit a single
 * `audit-retention-sustained-failure` and back off exponentially
 * (capped at 24 ticks). A successful run emits
 * `audit-retention-recovered` and resets state.
 *
 * Single-process invariant (ADR-0021). Multi-replica deployments
 * would emit N log lines per run — revisit when that topology is
 * considered.
 *
 * The retention service itself is the sole deleter of `audit_log`
 * rows — see `src/server/services/audit-retention.ts` and the
 * architecture-check allowlist in
 * `scripts/check-audit-mutations.sh`. This module only drives the
 * schedule; it does not touch the table directly.
 */

import type { Database } from './db/connection.js';
import { runAuditRetentionCleanup } from './services/audit-retention.js';
import type { ServiceLogger } from './services/Logger.js';

/**
 * Operational-log event names emitted by the scheduler. Kebab-case to
 * stay consistent with the audit subsystem's AC-pinned events
 * `audit-retention-cleanup` (AC-184) and `audit-publisher-handler-error`
 * (AC-183). Not AC-pinned themselves — rename with care regardless,
 * operators grep the log for these strings.
 */
export const EVENT_SWEEP_FAILED = 'audit-retention-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'audit-retention-sustained-failure';
export const EVENT_RECOVERED = 'audit-retention-recovered';

export interface StartAuditRetentionSchedulerOptions {
  db: Database;
  intervalMinutes: number;
  /** Retention window in days — resolved by the caller from env + [C] default. */
  windowDays: number;
  logger: ServiceLogger;
}

export interface AuditRetentionScheduler {
  /** Cancel the interval and await any sweep already in flight. */
  stop: () => Promise<void>;
}

const SUSTAINED_FAILURE_CEILING = 3;
const MAX_BACKOFF_TICKS = 24;

export function startAuditRetentionScheduler(
  opts: StartAuditRetentionSchedulerOptions,
): AuditRetentionScheduler {
  const intervalMs = opts.intervalMinutes * 60 * 1000;
  let currentSweep: Promise<void> | null = null;
  const state: SweepState = { consecutiveFailures: 0, ticksToSkip: 0 };

  const handle = setInterval(() => {
    if (currentSweep) return;
    if (state.ticksToSkip > 0) {
      state.ticksToSkip -= 1;
      return;
    }
    currentSweep = sweep(opts, state).finally(() => {
      currentSweep = null;
    });
  }, intervalMs);
  // Don't keep the Node event loop alive just for this timer.
  handle.unref();

  return {
    stop: async () => {
      clearInterval(handle);
      if (currentSweep) await currentSweep;
    },
  };
}

interface SweepState {
  consecutiveFailures: number;
  ticksToSkip: number;
}

async function sweep(opts: StartAuditRetentionSchedulerOptions, state: SweepState): Promise<void> {
  try {
    // The service emits its own AC-184 log line. This scheduler only
    // adds recovery/failure lines around it.
    await runAuditRetentionCleanup({
      db: opts.db,
      logger: opts.logger,
      windowDays: opts.windowDays,
    });
    if (state.consecutiveFailures >= SUSTAINED_FAILURE_CEILING) {
      opts.logger.info({ event: EVENT_RECOVERED }, EVENT_RECOVERED);
    }
    state.consecutiveFailures = 0;
    state.ticksToSkip = 0;
  } catch (err) {
    state.consecutiveFailures += 1;
    opts.logger.error(
      {
        event: EVENT_SWEEP_FAILED,
        error_message: err instanceof Error ? err.message : String(err),
      },
      EVENT_SWEEP_FAILED,
    );
    if (state.consecutiveFailures === SUSTAINED_FAILURE_CEILING) {
      opts.logger.error(
        {
          event: EVENT_SUSTAINED_FAILURE,
          error_message: err instanceof Error ? err.message : String(err),
        },
        EVENT_SUSTAINED_FAILURE,
      );
    }
    if (state.consecutiveFailures >= SUSTAINED_FAILURE_CEILING) {
      const exponent = state.consecutiveFailures - SUSTAINED_FAILURE_CEILING + 1;
      state.ticksToSkip = Math.min(2 ** exponent, MAX_BACKOFF_TICKS);
    }
  }
}
