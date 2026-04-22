/**
 * Client-side attachment pipeline parameters.
 *
 * Centralises every value referenced by the browser upload pipeline and
 * the per-project-page enforcement surface. Each field is a `[C]`
 * customer-configurable setting per
 * [architecture.md §12.2](../../docs/spec/architecture.md#122-company-configurable-settings).
 *
 * Consumers:
 *   - `src/domain/imagePipeline.ts` reads the image/thumbnail encoding
 *     parameters and the per-file byte cap to enforce the size gate
 *     before calling `init` (matches the server-side presigned policy
 *     `content-length-range`, see
 *     [api.md §14.2.11](../../docs/spec/api.md#14211-attachments)).
 *   - `src/ui/detail/BinaryList.tsx` reads the bulk-download caps to
 *     block client-side selections exceeding either cap (AC-223).
 *
 * Defaults mirror the architecture spec §12.2:
 *   - per-file cap: 1 MB (AC-214 ceiling and policy upper bound)
 *   - bulk caps: 20 files AND 20 MB (AC-216 twin-cap predicate)
 *   - image-longest-edge / quality + thumbnail-longest-edge / quality
 *     are calibrated so a worker phone photo fits well within the
 *     1 MB per-file cap with EXIF (including GPS) preserved.
 *
 * Layer note: this module sits in the config layer (eslint CONFIG_BANNED).
 * It exports plain values — no domain imports — so the domain pipeline
 * imports these constants freely.
 */

import {
  BULK_DOWNLOAD_MAX_BYTES_DEFAULT,
  BULK_DOWNLOAD_MAX_FILES_DEFAULT,
} from './attachmentDefaults';

export interface AttachmentPipelineConfig {
  /** Longest edge (pixels) applied to the re-encoded original. [C] */
  imageMaxDimension: number;
  /** JPEG / WebP quality (0..1) applied to the re-encoded original. [C] */
  imageQuality: number;
  /** Longest edge (pixels) applied to the WebP thumbnail. [C] */
  thumbnailMaxDimension: number;
  /** WebP quality (0..1) applied to the thumbnail. [C] */
  thumbnailQuality: number;
  /** Per-file size cap (bytes) — matches the presigned policy ceiling. [C] */
  perFileSizeCapBytes: number;
  /** Bulk-download cap (file count). [C] */
  bulkDownloadMaxFiles: number;
  /** Bulk-download cap (summed byte size). [C] */
  bulkDownloadMaxBytes: number;
}

/** [C] — customer-configurable; see module docstring for rationale. */
export const ATTACHMENT_PIPELINE: AttachmentPipelineConfig = {
  imageMaxDimension: 2560,
  imageQuality: 0.82,
  thumbnailMaxDimension: 320,
  thumbnailQuality: 0.72,
  perFileSizeCapBytes: 1 * 1024 * 1024,
  bulkDownloadMaxFiles: BULK_DOWNLOAD_MAX_FILES_DEFAULT,
  bulkDownloadMaxBytes: BULK_DOWNLOAD_MAX_BYTES_DEFAULT,
};
