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
 * and Node (unit tests). `@uploadcare/image-shrink` requires a browser
 * environment (canvas + Image + URL.createObjectURL) that neither
 * jsdom nor Node provides. When `document.createElement('canvas').
 * getContext('2d')` is unavailable, `runImagePipeline` returns the
 * original file verbatim — no re-encode, no thumbnail — so the store's
 * orchestration path stays testable without a real browser.
 *
 * EXIF preservation — `@uploadcare/image-shrink` byte-splices the
 * source's APP1/EXIF segment back into the re-encoded JPEG. No IFD
 * parser sits in the path, so the LONG-vs-SHORT Orientation failure
 * mode that motivated the swap from `browser-image-compression` is
 * structurally absent. GPS rides along verbatim.
 *
 * Layer note: this module is in the domain layer. It imports nothing
 * from `state`, `ui`, `server`, `api`, or `hooks`; the only
 * application-internal dependency is the `[C]` catalogue at
 * `src/config/attachmentPipeline.ts`.
 */

import { shrinkFile } from '@uploadcare/image-shrink';
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
 * image-decoding operations the pipeline relies on?
 * `document.createElement('canvas').getContext('2d')` is the cheapest
 * probe that distinguishes a real browser from jsdom / Node.
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
 * Iterate `shrinkFile` until output fits under `cap`.
 *
 * `shrinkFile` does one shot at the given `(size, quality)` and returns
 * whatever the canvas encoder produces. High-detail phone JPEGs at the
 * default `(2560, 0.82)` typically land around 0.5–1.5 MB — sometimes
 * over the 1 MB cap. Iterate by knocking down quality first (less
 * destructive), then dimension. Stop at six attempts: if a photo can't
 * be coerced under the cap by then, the source is pathological (huge
 * uncompressible texture, or a near-RAW DNG that slipped through the
 * MIME gate) and we'd rather throw than ship megabytes of detail loss.
 */
const SHRINK_ATTEMPTS: ReadonlyArray<{ scale: number; qualityFactor: number }> = [
  { scale: 1, qualityFactor: 1 },
  { scale: 1, qualityFactor: 0.85 },
  { scale: 1, qualityFactor: 0.7 },
  { scale: 0.75, qualityFactor: 0.85 },
  { scale: 0.5, qualityFactor: 0.85 },
  { scale: 0.5, qualityFactor: 0.7 },
];

async function shrinkUntilUnderCap(
  file: Blob,
  baseSize: number,
  baseQuality: number,
  cap: number,
): Promise<Blob> {
  let last: Blob | null = null;
  for (const { scale, qualityFactor } of SHRINK_ATTEMPTS) {
    const out = await shrinkFile(file, {
      size: Math.round(baseSize * scale),
      quality: baseQuality * qualityFactor,
    });
    if (out.size <= cap) return out;
    last = out;
  }
  // Surface the tagged error so the store maps it to the
  // "Bildbearbeitung fehlgeschlagen" banner rather than a misleading
  // "Datei zu groß" from the post-pipeline cap check.
  void last;
  throw new Error('IMAGE_PROCESSING_FAILED');
}

/**
 * Encode a WebP thumbnail at `dimension` longest edge / `quality`.
 *
 * `shrinkFile` outputs JPEG (or PNG for transparent sources) only —
 * thumbnails are deliberately WebP (better compression at small sizes)
 * so the gallery payload stays light. EXIF is dropped from thumbnails
 * by design; the original carries GPS for the worker view.
 */
async function encodeWebpThumbnail(
  file: Blob,
  dimension: number,
  quality: number,
): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    const ratio = Math.min(dimension / img.naturalWidth, dimension / img.naturalHeight, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/webp', quality);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/**
 * Run the client-side upload pipeline for a single file.
 *
 * For photo MIME types (`image/jpeg`, `image/png`, `image/webp`):
 *   1. The original is downscaled to `imageMaxDimension` and re-encoded
 *      via `@uploadcare/image-shrink`. EXIF is byte-spliced from the
 *      source so GPS / orientation survive. The output is iterated
 *      until it fits under `perFileSizeCapBytes`.
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

  const mimeType = file.type;

  let original: Blob;
  try {
    original = await shrinkUntilUnderCap(
      file,
      ATTACHMENT_PIPELINE.imageMaxDimension,
      ATTACHMENT_PIPELINE.imageQuality,
      ATTACHMENT_PIPELINE.perFileSizeCapBytes,
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'IMAGE_PROCESSING_FAILED') {
      throw err;
    }
    // Decode failure, OOM, blocked toBlob — surface as the tagged error
    // so the store's banner reads "Bildbearbeitung fehlgeschlagen"
    // instead of the post-pipeline cap's misleading "Datei zu groß".
    console.warn('[imagePipeline] original compression failed', err);
    throw new Error('IMAGE_PROCESSING_FAILED');
  }

  let thumbnail: Blob | null = null;
  if (opts.hasThumbnail) {
    try {
      thumbnail = await encodeWebpThumbnail(
        file,
        ATTACHMENT_PIPELINE.thumbnailMaxDimension,
        ATTACHMENT_PIPELINE.thumbnailQuality,
      );
    } catch {
      // Thumbnail is opportunistic — leave it null and let the store
      // clear `hasThumbnail` so the server issues only one descriptor.
      thumbnail = null;
    }
  }

  return {
    original,
    thumbnail,
    mimeType,
    sizeBytes: original.size,
  };
}
