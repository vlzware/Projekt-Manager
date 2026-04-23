/**
 * Client-side image pipeline for attachment uploads
 * (ui/project-detail.md §8.15.4).
 *
 * Takes a raw `File` picked from the browser and returns the originals
 * that the upload store will POST to object storage:
 *   - `original` — the re-encoded file the user sees when clicking an
 *     attachment's lightbox. EXIF is preserved so GPS stays intact for
 *     the worker's field-capture context.
 *   - `thumbnail` — a short-edge WebP the gallery renders. Always
 *     produced for photo kinds; `null` for binaries and for requests
 *     with `hasThumbnail = false`.
 *   - `mimeType` — the final MIME of the original (unchanged from input
 *     for JPEG/PNG/WebP; kind is pinned by `classifyKind`).
 *   - `sizeBytes` — the final byte size of the original (matches what
 *     the presigned-POST policy expects at `init` time).
 *
 * The pipeline is a pure module: it takes a `File` and settings, and
 * returns processed blobs. It never touches the store or API.
 *
 * Environment fallback — the module is imported from `src/state/
 * attachmentStore.ts`, which runs under both jsdom (component tests)
 * and Node (unit tests). `browser-image-compression` requires a full
 * browser environment (canvas + workers) that neither jsdom nor Node
 * provides. When `document.createElement('canvas').getContext('2d')`
 * is unavailable, `runImagePipeline` returns the original file verbatim
 * — no re-encode, no thumbnail — so the store's orchestration path
 * stays testable without a real browser.
 *
 * Layer note: this module is in the domain layer. It imports nothing
 * from `state`, `ui`, `server`, `api`, or `hooks`; the only
 * application-internal dependency is the `[C]` catalogue at
 * `src/config/attachmentPipeline.ts`.
 */

import imageCompression from 'browser-image-compression';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';
import { classifyKind } from './attachments';

export interface ProcessedUpload {
  /** Bytes that will be POSTed to the `originalUpload` presigned URL. */
  original: Blob;
  /** Bytes that will be POSTed to `thumbnailUpload`, or `null` for binaries. */
  thumbnail: Blob | null;
  /** Final MIME type of the original. */
  mimeType: string;
  /** Final size in bytes of the original. */
  sizeBytes: number;
}

/**
 * Liberal raw-source size cap used by the caller (store) to reject
 * obvious garbage before any pipeline work starts. The post-pipeline
 * check against `perFileSizeCapBytes` is still authoritative for
 * photos, because downscale + re-encode may squeeze a large source
 * under the cap. This gate just short-circuits multi-hundred-MB inputs
 * that could never compress enough to be viable.
 *
 * Picked at 30× `perFileSizeCapBytes` — modern phones (50 MP sensors
 * on Pixel, Samsung) commonly emit 10–15 MB JPEGs; the earlier 4×
 * ceiling was tripping on ordinary field captures and rejecting them
 * before the compressor ever ran. 30× leaves plenty of headroom for
 * those sources while still catching multi-GB mispicks.
 */
export function exceedsRawCap(file: File): boolean {
  return file.size > ATTACHMENT_PIPELINE.perFileSizeCapBytes * 30;
}

/**
 * Heuristic: is the current runtime a browser capable of the canvas /
 * image-decoding operations `browser-image-compression` relies on?
 * `document.createElement('canvas').getContext('2d')` is the same
 * probe `browser-image-compression` uses internally on its fast path;
 * failing it up front avoids a confusing deep-import error.
 */
function canProcessImages(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return typeof canvas.getContext === 'function' && canvas.getContext('2d') !== null;
  } catch {
    return false;
  }
}

/**
 * Passthrough result — used in Node and in jsdom where canvas is absent.
 * The server still validates MIME + size, so a pass-through just means
 * the client can't participate in the downscale/re-encode optimisation.
 */
function passthrough(file: File): ProcessedUpload {
  return {
    original: file,
    thumbnail: null,
    mimeType: file.type,
    sizeBytes: file.size,
  };
}

/**
 * Run the client-side upload pipeline for a single file.
 *
 * For photo MIME types (`image/jpeg`, `image/png`, `image/webp`):
 *   1. The original is downscaled to `imageMaxDimension` and re-encoded
 *      via `browser-image-compression` with `preserveExif: true`, so
 *      the camera's EXIF (GPS, orientation) carries through the
 *      re-encode.
 *   2. If `hasThumbnail` is true, a WebP thumbnail is generated at
 *      `thumbnailMaxDimension`.
 *
 * For binary MIME types, the file is passed through verbatim (no
 * thumbnail, no re-encode). The server still enforces the MIME
 * whitelist and size cap.
 */
export async function runImagePipeline(
  file: File,
  opts: { hasThumbnail: boolean },
): Promise<ProcessedUpload> {
  // Not a browser-capable runtime → pass through. The store's size-cap
  // check still runs against the raw file size, so we never upload
  // something the server would reject at the policy level.
  if (!canProcessImages()) {
    return passthrough(file);
  }

  // Binary kinds are uploaded as-is; server-side validation pins the
  // MIME and size ceiling.
  let kind: 'photo' | 'binary';
  try {
    kind = classifyKind(file.type);
  } catch {
    // Unknown MIME — let the server produce the authoritative error.
    // Pipeline stays a pure projection of the input.
    return passthrough(file);
  }

  if (kind === 'binary') {
    return passthrough(file);
  }

  // --- Photo branch ---------------------------------------------------------

  // Downscale + re-encode original. `preserveExif: true` copies the
  // APP1/EXIF segment from the source JPEG (GPS + orientation) into
  // the re-encoded blob — the camera's original metadata rides along.
  //
  // `maxSizeMB` makes the library iterate (quality + dimension knockdown,
  // up to `maxIteration` rounds) until the output fits under the
  // per-file cap. Without it, one-shot q=0.82 compression commonly
  // lands at 1.2–2 MB for high-detail phone JPEGs and trips the 1 MB
  // post-pipeline check — the exact symptom that previously surfaced
  // as a misleading "Datei zu groß".
  const mimeType = file.type;
  let original: Blob;
  let originalSize: number;
  try {
    const compressed = await imageCompression(file, {
      maxSizeMB: ATTACHMENT_PIPELINE.perFileSizeCapBytes / (1024 * 1024),
      maxWidthOrHeight: ATTACHMENT_PIPELINE.imageMaxDimension,
      initialQuality: ATTACHMENT_PIPELINE.imageQuality,
      useWebWorker: true,
      preserveExif: true,
      fileType: mimeType,
    });
    original = compressed;
    originalSize = compressed.size;
  } catch (err) {
    // Surface a tagged error so the store can mark the upload failed
    // with a distinct "Bildbearbeitung fehlgeschlagen" message. The
    // prior silent-fallback path handed the raw file to the store,
    // which then tripped the per-file size cap and reported
    // "Datei zu groß" — a misleading diagnosis of an entirely
    // different failure mode (canvas OOM, worker crash, decode bug).
    console.warn('[imagePipeline] original compression failed', err);
    throw new Error('IMAGE_PROCESSING_FAILED');
  }

  // WebP thumbnail. Only generated when the caller asks for one
  // (photo upload path sets `hasThumbnail = true`).
  let thumbnail: Blob | null = null;
  if (opts.hasThumbnail) {
    try {
      const thumbBlob = await imageCompression(file, {
        maxWidthOrHeight: ATTACHMENT_PIPELINE.thumbnailMaxDimension,
        initialQuality: ATTACHMENT_PIPELINE.thumbnailQuality,
        useWebWorker: true,
        fileType: 'image/webp',
      });
      thumbnail = thumbBlob;
    } catch {
      // Thumbnail generation failed — leave `thumbnail` null; the caller
      // (store) will clear `hasThumbnail` so the server issues only one
      // presigned descriptor.
      thumbnail = null;
    }
  }

  return {
    original,
    thumbnail,
    mimeType,
    sizeBytes: originalSize,
  };
}
