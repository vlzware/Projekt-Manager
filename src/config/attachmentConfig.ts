/**
 * Attachment policy constants — per-file cap, bulk-download caps,
 * orphan-reaper TTL, worker self-delete grace.
 *
 * All four values are customer-configurable **[C]** per architecture.md
 * §12.2 and pinned by verification.md AC-211/213/215/216. Defaults are
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
  bulkDownloadMaxFiles: BULK_DOWNLOAD_MAX_FILES_DEFAULT,
  bulkDownloadMaxBytes: BULK_DOWNLOAD_MAX_BYTES_DEFAULT,
  orphanReaperTtlMinutes: 15,
  workerSelfDeleteGraceMinutes: 15,
};
