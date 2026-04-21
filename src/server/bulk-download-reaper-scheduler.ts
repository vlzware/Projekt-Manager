/**
 * Periodic bulk-download reaper scheduler — sibling of
 * `attachment-orphan-reaper-scheduler.ts`.
 *
 * Sweeps `bulk-downloads/` temp zips past the TTL on the same cadence
 * as the orphan reaper (default 5 min, configurable via
 * `ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES`). The two sweeps are
 * independent — a failure in one does not block the other.
 *
 * Mirrors the orphan-reaper scheduler's exponential-backoff behavior
 * on sustained failures so a misconfigured storage surface cannot log
 * a stream of per-minute errors. The constants + event names diverge
 * so operators can separate signal-by-origin in the op-log.
 */

import type { StorageClient } from './storage/client.js';
import { runBulkDownloadReaper } from './services/bulk-download-reaper.js';
import type { ServiceLogger } from './services/Logger.js';

export const EVENT_SWEEP_FAILED = 'bulk-download-reaper-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'bulk-download-reaper-sustained-failure';
export const EVENT_RECOVERED = 'bulk-download-reaper-recovered';

export interface StartBulkDownloadReaperSchedulerOptions {
  storage: StorageClient;
  intervalMinutes: number;
  ttlMinutes: number;
  logger: ServiceLogger;
}

export interface BulkDownloadReaperScheduler {
  stop: () => Promise<void>;
}

const SUSTAINED_FAILURE_CEILING = 3;
const MAX_BACKOFF_TICKS = 24;

export function startBulkDownloadReaperScheduler(
  opts: StartBulkDownloadReaperSchedulerOptions,
): BulkDownloadReaperScheduler {
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
  opts: StartBulkDownloadReaperSchedulerOptions,
  state: SweepState,
): Promise<void> {
  try {
    await runBulkDownloadReaper({
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
