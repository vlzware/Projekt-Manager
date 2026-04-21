/**
 * Bulk-download temp-zip reaper — sibling of `attachment-orphan-reaper`.
 *
 * Bulk-download zips (api.md §14.2.11, AC-216) are staged under
 * `bulk-downloads/<uuid>.zip` so the client can download them via a
 * presigned URL. They are storage-only ephemera — no DB row, no audit
 * trail — so the orphan-reaper's DB-driven pattern does not apply.
 *
 * This reaper instead:
 *   1. Lists `bulk-downloads/` via `storage.listObjects(prefix, olderThan)`,
 *      filtering to objects whose `LastModified` precedes the TTL cutoff.
 *   2. Deletes each returned key.
 *
 * TTL: reuses the orphan-reaper TTL
 * (`ATTACHMENT_CONFIG.orphanReaperTtlMinutes`, default 15 min). Rationale:
 * both values are "staleness of a short-lived storage artifact"; carrying
 * a separate env var would add a configuration knob the operator never
 * needs to turn independently. A bulk-download presigned URL expires in
 * 5 min (inherited from `createPresignedGet`), so 15 min is a generous
 * safety margin that still stays well under any storage-lifecycle
 * policy.
 *
 * Operational-log contract mirrors the orphan reaper:
 *   event: 'bulk-download-reaper'
 *   ttl_minutes: number
 *   removed_count: number (non-negative; 0 on no-op)
 *   ran_at: ISO 8601
 *
 * Failure semantics: a delete that fails is logged with `error_hint`
 * and the sweep continues with the next key. Partial progress is fine —
 * the next sweep picks up what was left. This is identical to the
 * orphan reaper's policy and for the same reason (§6.11).
 */

import type { StorageClient } from '../storage/client.js';
import type { ServiceLogger } from './Logger.js';
import { BULK_DOWNLOAD_PREFIX } from './AttachmentService.js';

const MS_PER_MINUTE = 60 * 1000;

export interface RunBulkDownloadReaperDeps {
  storage: StorageClient;
  logger: ServiceLogger;
  ttlMinutes: number;
  /** Injectable wall clock for deterministic testing. */
  now?: Date;
}

export const EVENT_BULK_DOWNLOAD_REAPER = 'bulk-download-reaper';

export async function runBulkDownloadReaper(deps: RunBulkDownloadReaperDeps): Promise<void> {
  if (!Number.isInteger(deps.ttlMinutes) || deps.ttlMinutes <= 0) {
    throw new Error(
      `runBulkDownloadReaper: ttlMinutes must be a positive integer, got ${deps.ttlMinutes}`,
    );
  }

  if (!deps.storage.listObjects || !deps.storage.deleteObject) {
    // `AttachmentStorageClient` makes these mandatory at the type level;
    // this guard is for the occasional Tier-1 mock that satisfies
    // `StorageClient` (the reaper-scheduler accepts the wider type for
    // wiring symmetry with the orphan reaper).
    throw new Error('runBulkDownloadReaper: storage client missing listObjects/deleteObject');
  }

  const runAt = deps.now ?? new Date();
  const cutoff = new Date(runAt.getTime() - deps.ttlMinutes * MS_PER_MINUTE);

  const staleKeys = await deps.storage.listObjects(BULK_DOWNLOAD_PREFIX, cutoff);

  let removed = 0;
  for (const key of staleKeys) {
    try {
      await deps.storage.deleteObject(key);
      removed += 1;
    } catch (err) {
      deps.logger.error(
        {
          event: EVENT_BULK_DOWNLOAD_REAPER,
          error_hint: err instanceof Error ? err.message : String(err),
          key,
        },
        EVENT_BULK_DOWNLOAD_REAPER,
      );
    }
  }

  deps.logger.info(
    {
      event: EVENT_BULK_DOWNLOAD_REAPER,
      ttl_minutes: deps.ttlMinutes,
      removed_count: removed,
      ran_at: runAt.toISOString(),
    },
    EVENT_BULK_DOWNLOAD_REAPER,
  );
}
