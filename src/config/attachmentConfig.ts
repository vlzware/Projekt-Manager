/**
 * Attachment policy constants — per-file cap, bulk-download caps,
 * orphan-reaper TTL, worker self-delete grace.
 *
 * All four values are customer-configurable **[C]** per architecture.md
 * §12.2 and pinned by verification.md AC-245/213/215/216. Defaults are
 * the shipping values documented in the spec; deployments override via
 * the env layer (`src/server/config/env.ts`) and the server resolves at
 * call time.
 *
 * Layering: mirrors `backupThresholds.ts` / `auditRetention.ts` — the
 * config layer owns defaults, the server's env loader owns the override,
 * and the service layer receives the resolved value as an explicit arg.
 */

import {
  BULK_DOWNLOAD_MAX_BYTES_DEFAULT,
  BULK_DOWNLOAD_MAX_FILES_DEFAULT,
} from './attachmentDefaults';

export interface AttachmentConfig {
  /** Maximum sizeBytes of a single attachment original. [C] */
  perFileCapBytes: number;
  /**
   * Maximum sizeBytes of a single thumbnail blob. [C]
   *
   * The thumbnail pipeline (`src/config/attachmentPipeline.ts`) encodes a
   * 320 px-shortest-edge WebP at q=0.72 — real-world output sits in the
   * 3-30 KB range. Capping at 200 KB leaves an order of magnitude of
   * headroom for outliers (high-detail captures, browsers that ignore
   * the q parameter) while still keeping a thumbnail one decimal order
   * smaller than the per-file cap (1 MB). Without this separate cap a
   * client could declare a 1 MB "thumbnail" and obtain a signed PUT for
   * it — the original-side cap protects originals, not thumbs.
   */
  perThumbCapBytes: number;
  /** Maximum attachment count per bulk-download zip stream. [C] */
  bulkDownloadMaxFiles: number;
  /** Maximum summed sizeBytes per bulk-download zip stream. [C] */
  bulkDownloadMaxBytes: number;
  /** Pending-row age (minutes) past which the orphan reaper removes the row. [C] */
  orphanReaperTtlMinutes: number;
  /** Worker self-delete grace window (minutes) since upload. [C] */
  workerSelfDeleteGraceMinutes: number;
}

/** [C] — defaults pinned by data-model.md §5.13 and architecture.md §12.2. */
export const ATTACHMENT_CONFIG: AttachmentConfig = {
  perFileCapBytes: 1 * 1024 * 1024,
  perThumbCapBytes: 200 * 1024,
  bulkDownloadMaxFiles: BULK_DOWNLOAD_MAX_FILES_DEFAULT,
  bulkDownloadMaxBytes: BULK_DOWNLOAD_MAX_BYTES_DEFAULT,
  orphanReaperTtlMinutes: 15,
  workerSelfDeleteGraceMinutes: 15,
};
