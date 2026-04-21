/**
 * Client-side image pipeline for attachment uploads
 * (ui/project-detail.md §8.15.4).
 *
 * Takes a raw `File` picked from the browser and returns the originals
 * that the upload store will POST to object storage:
 *   - `original` — the re-encoded (and for HEIC, transcoded) file the
 *     user sees when clicking an attachment's lightbox. EXIF is
 *     preserved so GPS stays intact for the worker's field-capture
 *     context.
 *   - `thumbnail` — a short-edge WebP the gallery renders. Always
 *     produced for photo kinds; `null` for binaries and for requests
 *     with `hasThumbnail = false`.
 *   - `mimeType` — the final MIME of the original (HEIC → JPEG).
 *   - `sizeBytes` — the final byte size of the original (matches what
 *     the presigned-POST policy expects at `init` time).
 *
 * The pipeline is a pure module: it takes a `File` and settings, and
 * returns processed blobs. It never touches the store or API.
 *
 * Environment fallback — the module is imported from `src/state/
 * attachmentStore.ts`, which runs under both jsdom (component tests)
 * and Node (unit tests). `browser-image-compression` and `heic-to`
 * both require a full browser environment (canvas + workers) that
 * neither jsdom nor Node provides. When `document.createElement('canvas')
 * .getContext('2d')` is unavailable, `runImagePipeline` returns the
 * original file verbatim — no re-encode, no thumbnail — so the store's
 * orchestration path stays testable without a real browser.
 *
 * Layer note: this module is in the domain layer. It imports nothing
 * from `state`, `ui`, `server`, `api`, or `hooks`; the only
 * application-internal dependency is the `[C]` catalogue at
 * `src/config/attachmentPipeline.ts`.
 */

import imageCompression from 'browser-image-compression';
import { heicTo } from 'heic-to';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';
import { classifyKind } from './attachments';

export interface ProcessedUpload {
  /** Bytes that will be POSTed to the `originalUpload` presigned URL. */
  original: Blob;
  /** Bytes that will be POSTed to `thumbnailUpload`, or `null` for binaries. */
  thumbnail: Blob | null;
  /** Final MIME type of the original (HEIC → JPEG). */
  mimeType: string;
  /** Final size in bytes of the original. */
  sizeBytes: number;
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
 * For photo MIME types (`image/jpeg`, `image/png`, `image/webp`,
 * `image/heic`):
 *   1. HEIC inputs are transcoded to JPEG via `heic-to`.
 *   2. The original is downscaled to `imageMaxDimension` and re-encoded
 *      via `browser-image-compression` with EXIF preserved.
 *   3. If `hasThumbnail` is true, a WebP thumbnail is generated at
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

  // Step 1: HEIC → JPEG (lossy transcode, EXIF preserved by `heic-to`).
  let workingFile: File | Blob = file;
  let mimeType = file.type;
  if (mimeType === 'image/heic') {
    try {
      const jpeg = await heicTo({
        blob: file,
        type: 'image/jpeg',
        quality: ATTACHMENT_PIPELINE.imageQuality,
      });
      workingFile = jpeg;
      mimeType = 'image/jpeg';
    } catch {
      // HEIC transcode failed — fall back to the raw file; the server
      // whitelist permits HEIC so it can still land.
      workingFile = file;
      mimeType = file.type;
    }
  }

  // Step 2: downscale + re-encode original. `preserveExif: true` is the
  // switch that carries GPS through — matches kickoff.md's worker-view
  // expectation.
  let original: Blob = workingFile;
  let originalSize = workingFile instanceof File ? workingFile.size : workingFile.size;
  try {
    const compressed = await imageCompression(
      workingFile instanceof File
        ? workingFile
        : new File([workingFile], file.name, { type: mimeType }),
      {
        maxWidthOrHeight: ATTACHMENT_PIPELINE.imageMaxDimension,
        initialQuality: ATTACHMENT_PIPELINE.imageQuality,
        useWebWorker: true,
        preserveExif: true,
        fileType: mimeType,
      },
    );
    original = compressed;
    originalSize = compressed.size;
  } catch {
    // Compression failed — fall back to the HEIC-transcode output (or
    // the raw file). The server still enforces the cap and the UI will
    // surface "Datei zu groß" before init if the fallback exceeds it.
  }

  // Step 3: WebP thumbnail. Only generated when the caller asks for
  // one (photo upload path sets `hasThumbnail = true`).
  let thumbnail: Blob | null = null;
  if (opts.hasThumbnail) {
    try {
      const thumbBlob = await imageCompression(
        workingFile instanceof File
          ? workingFile
          : new File([workingFile], file.name, { type: mimeType }),
        {
          maxWidthOrHeight: ATTACHMENT_PIPELINE.thumbnailMaxDimension,
          initialQuality: ATTACHMENT_PIPELINE.thumbnailQuality,
          useWebWorker: true,
          fileType: 'image/webp',
        },
      );
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
