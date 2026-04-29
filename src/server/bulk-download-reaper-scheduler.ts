/**
 * Periodic bulk-download reaper scheduler — sibling of
 * `attachment-orphan-reaper-scheduler.ts`.
 *
 * Thin caller over `createPeriodicSweeper` (see
 * `src/server/periodicSweeper.ts`): the timer drive, sustained-
 * failure backoff, and `stop()` drain are shared with the audit
 * retention and attachment orphan reaper schedulers.
 *
 * Sweeps `bulk-downloads/` temp zips past the TTL on the same cadence
 * as the orphan reaper (default 5 min, configurable via
 * `ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES`). The two sweeps are
 * independent — a failure in one does not block the other. The
 * constants + event names diverge so operators can separate signal-
 * by-origin in the op-log.
 *
 * Single-process invariant (ADR-0021). Multi-replica deployments
 * would need a lease at this caller site.
 */

import type { AttachmentStorageClient } from './storage/client.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import { runBulkDownloadReaper } from './services/bulk-download-reaper.js';
import type { ServiceLogger } from './services/Logger.js';

export const EVENT_SWEEP_FAILED = 'bulk-download-reaper-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'bulk-download-reaper-sustained-failure';
export const EVENT_RECOVERED = 'bulk-download-reaper-recovered';

export interface StartBulkDownloadReaperSchedulerOptions {
  storage: AttachmentStorageClient;
  intervalMinutes: number;
  ttlMinutes: number;
  logger: ServiceLogger;
}

export type BulkDownloadReaperScheduler = PeriodicSweeperHandle;

export function startBulkDownloadReaperScheduler(
  opts: StartBulkDownloadReaperSchedulerOptions,
): BulkDownloadReaperScheduler {
  return createPeriodicSweeper({
    intervalMs: opts.intervalMinutes * 60 * 1000,
    logger: opts.logger,
    events: {
      sweepFailed: EVENT_SWEEP_FAILED,
      sustainedFailure: EVENT_SUSTAINED_FAILURE,
      recovered: EVENT_RECOVERED,
    },
    sweep: () =>
      runBulkDownloadReaper({
        storage: opts.storage,
        logger: opts.logger,
        ttlMinutes: opts.ttlMinutes,
      }),
  });
}
