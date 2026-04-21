/**
 * Periodic attachment orphan reaper scheduler — data-model.md §6.11.
 *
 * Mirrors `audit-retention-scheduler.ts`: setInterval sweep, unref'd
 * handle, never-propagate sweep errors, `stop()` awaits any in-flight
 * run so graceful shutdown doesn't tear down the pg pool mid-query.
 *
 * The reaper service is the sole deleter of `pending` rows via this
 * path; the architecture-check allowlist in
 * `scripts/check-audit-mutations.sh` names the service file, not this
 * scheduler, because this module only drives the schedule.
 */

import type { Database } from './db/connection.js';
import type { AttachmentStorageClient } from './storage/client.js';
import { runAttachmentOrphanReaper } from './services/attachment-orphan-reaper.js';
import type { ServiceLogger } from './services/Logger.js';

export type { AttachmentStorageClient };

export const EVENT_SWEEP_FAILED = 'attachment-orphan-reaper-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'attachment-orphan-reaper-sustained-failure';
export const EVENT_RECOVERED = 'attachment-orphan-reaper-recovered';

export interface StartAttachmentOrphanReaperSchedulerOptions {
  db: Database;
  storage: AttachmentStorageClient;
  intervalMinutes: number;
  ttlMinutes: number;
  logger: ServiceLogger;
}

export interface AttachmentOrphanReaperScheduler {
  stop: () => Promise<void>;
}

const SUSTAINED_FAILURE_CEILING = 3;
const MAX_BACKOFF_TICKS = 24;

export function startAttachmentOrphanReaperScheduler(
  opts: StartAttachmentOrphanReaperSchedulerOptions,
): AttachmentOrphanReaperScheduler {
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

async function sweep(
  opts: StartAttachmentOrphanReaperSchedulerOptions,
  state: SweepState,
): Promise<void> {
  try {
    await runAttachmentOrphanReaper({
      db: opts.db,
      storage: opts.storage,
      logger: opts.logger,
      ttlMinutes: opts.ttlMinutes,
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
