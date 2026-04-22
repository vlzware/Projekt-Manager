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
 * and Node (unit tests). `browser-image-compression` and `heic-to/next`
 * both require a full browser environment (canvas + workers) that
 * neither jsdom nor Node provides. When `document.createElement('canvas')
 * .getContext('2d')` is unavailable, `runImagePipeline` returns the
 * original file verbatim — no re-encode, no thumbnail — so the store's
 * orchestration path stays testable without a real browser.
 *
 * EXIF preservation for HEIC — `heic-to` decodes to raw pixels and
 * encodes via `canvas.convertToBlob('image/jpeg')`, which strips the
 * entire EXIF segment. To keep the kickoff's worker-view promise
 * ("preserving EXIF including GPS", spec §8.15.4) we:
 *   1. read EXIF from the HEIC source via `exifr`,
 *   2. translate exifr's parsed IFD blocks into piexifjs's numeric-key
 *      shape and inject them into the JPEG with `piexif.insert`,
 *   3. let the downstream `browser-image-compression` step carry that
 *      EXIF through its `preserveExif: true` branch.
 *
 * Layer note: this module is in the domain layer. It imports nothing
 * from `state`, `ui`, `server`, `api`, or `hooks`; the only
 * application-internal dependency is the `[C]` catalogue at
 * `src/config/attachmentPipeline.ts`.
 */

import imageCompression from 'browser-image-compression';
import exifr from 'exifr';
// `heic-to/next` runs libheif decode inside a Web Worker via
// OffscreenCanvas — the default `heic-to` entry point decodes on the
// main thread and freezes the UI for a multi-MB iPhone HEIC.
import { heicTo } from 'heic-to/next';
import piexif from 'piexifjs';
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
 * Liberal raw-source size cap used by the caller (store) to reject
 * obvious garbage before any pipeline work starts. The post-pipeline
 * check against `perFileSizeCapBytes` is still authoritative for
 * photos, because HEIC→JPEG + downscale may squeeze a large source
 * under the cap. This gate just short-circuits multi-hundred-MB inputs
 * that could never compress enough to be viable.
 *
 * Picked at 4× `perFileSizeCapBytes` — an iPhone HEIC comfortably fits,
 * but a 20 GB upload is caught immediately.
 */
export function exceedsRawCap(file: File): boolean {
  return file.size > ATTACHMENT_PIPELINE.perFileSizeCapBytes * 4;
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

// ---------------------------------------------------------------------------
// EXIF interop — exifr → piexifjs bridge for the HEIC path.
//
// exifr collapses TIFF Rationals into plain numbers at parse time (see
// src/segment-parsers/tiff-exif.mjs), and piexifjs's `dump()` expects
// Rationals as `[num, den]` tuples. We rebuild Rationals from the
// surfaced floats with a constant scale (1_000_000) — lossy for the
// last few decimals but faithful for the orders of magnitude that
// matter (FNumber, ExposureTime, FocalLength).
//
// For the kickoff-critical GPS fields we use exifr's decoded
// `gps.latitude` / `gps.longitude` doubles and re-split them into the
// `[deg, min, sec]` triple form piexifjs wants. GPSLatitudeRef /
// GPSLongitudeRef come from the sign of the decoded double.
// ---------------------------------------------------------------------------

const RATIONAL_SCALE = 1_000_000;

function floatToRational(value: number): [number, number] {
  if (!Number.isFinite(value)) return [0, 1];
  return [Math.round(value * RATIONAL_SCALE), RATIONAL_SCALE];
}

/**
 * Decompose decimal degrees into the `[[deg,1], [min,1], [sec*n,n]]`
 * rational triple piexifjs expects for GPSLatitude / GPSLongitude.
 */
function degreesToDmsRational(absDeg: number): [number, number][] {
  const d = Math.floor(absDeg);
  const mFloat = (absDeg - d) * 60;
  const m = Math.floor(mFloat);
  const sScaled = Math.round((mFloat - m) * 60 * 10000);
  return [
    [d, 1],
    [m, 1],
    [sScaled, 10000],
  ];
}

interface ExifrIfdBlocks {
  ifd0?: Record<number, unknown>;
  exif?: Record<number, unknown>;
  gps?: Record<number, unknown>;
  ifd1?: Record<number, unknown>;
  // exifr also surfaces gps.latitude / gps.longitude as decoded doubles
  // when mergeOutput is false but gps block is enabled — we rely on
  // these for the DMS re-split below.
}

interface PiexifExifDict {
  '0th': Record<number, unknown>;
  Exif: Record<number, unknown>;
  GPS: Record<number, unknown>;
  '1st': Record<number, unknown>;
  thumbnail: null;
}

/**
 * Read EXIF from the raw HEIC file and convert it into the dict shape
 * piexifjs's `dump()` expects. Returns `null` if the source has no
 * EXIF (e.g., a HEIC rendered without TIFF metadata). The caller then
 * skips the injection step — nothing to preserve.
 */
async function readExifForPiexif(file: Blob): Promise<PiexifExifDict | null> {
  // Read the full file up front and hand exifr a `Uint8Array`. exifr
  // accepts either a Blob (reads via FileReader) or a typed array — the
  // typed-array path avoids the FileReader dependency, which matters
  // for non-browser test environments and matches what we already read
  // for the transcode step anyway (heic-to reads `file.arrayBuffer()`).
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }

  let parsed: ExifrIfdBlocks | undefined;
  try {
    // exifr's `Options` typing requires `ifd0` to be a `FormatOptions`
    // object (no `true` shortcut in the type, despite the README). The
    // runtime accepts `true`, so cast through `unknown` — the option
    // shape is validated by exifr itself.
    const parseOptions = {
      // Keep output split into IFD blocks — we need the grouping for
      // piexifjs, not a merged dictionary.
      mergeOutput: false,
      // Numeric tag IDs line up one-to-one between TIFF and piexifjs.
      translateKeys: false,
      // Leave raw values as parsed (no Date objects, no humanised
      // GPSVersionID string) so piexif's byte packer can round-trip them.
      translateValues: false,
      reviveValues: false,
      // IFD blocks we actually care about.
      ifd0: true,
      exif: true,
      gps: true,
      ifd1: false,
    } as unknown as Parameters<typeof exifr.parse>[1];
    parsed = (await exifr.parse(bytes, parseOptions)) as ExifrIfdBlocks | undefined;
  } catch {
    // Corrupt EXIF in source → skip injection, pipeline still runs.
    return null;
  }
  if (!parsed) return null;

  // Pull the decoded GPS doubles separately — translateKeys: false
  // suppresses the `.latitude` / `.longitude` convenience fields, so
  // run a second small parse with defaults for those two values only.
  let gpsDoubles: { latitude?: number; longitude?: number } | null = null;
  try {
    const result = (await exifr.gps(bytes)) as
      | { latitude?: number; longitude?: number }
      | undefined;
    gpsDoubles = result ?? null;
  } catch {
    gpsDoubles = null;
  }

  const dict: PiexifExifDict = {
    '0th': {},
    Exif: {},
    GPS: {},
    '1st': {},
    thumbnail: null,
  };

  // 0th IFD — image-level tags (Make, Model, Orientation, DateTime,
  // XResolution, YResolution, ResolutionUnit, Software, …). Most are
  // ASCII / Short / Long / Rational — copy values verbatim; rewrap
  // rationals.
  if (parsed.ifd0) {
    copyIfdBlock(parsed.ifd0, dict['0th'], 'Image');
  }

  // Exif IFD — DateTimeOriginal, ExposureTime, FNumber, ISO, …
  if (parsed.exif) {
    copyIfdBlock(parsed.exif, dict.Exif, 'Exif');
  }

  // GPS IFD — version, ref tags, and the DMS triples. For Latitude /
  // Longitude we rebuild from the decoded doubles (exifr drops the
  // original [d,m,s] rational chain during parse).
  if (parsed.gps) {
    copyIfdBlock(parsed.gps, dict.GPS, 'GPS');
  }
  if (gpsDoubles?.latitude !== undefined && gpsDoubles.latitude !== null) {
    const lat = gpsDoubles.latitude;
    dict.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
    dict.GPS[piexif.GPSIFD.GPSLatitude] = degreesToDmsRational(Math.abs(lat));
  }
  if (gpsDoubles?.longitude !== undefined && gpsDoubles.longitude !== null) {
    const lon = gpsDoubles.longitude;
    dict.GPS[piexif.GPSIFD.GPSLongitudeRef] = lon >= 0 ? 'E' : 'W';
    dict.GPS[piexif.GPSIFD.GPSLongitude] = degreesToDmsRational(Math.abs(lon));
  }

  return dict;
}

type PiexifTagTypeGroup = 'Image' | 'Exif' | 'GPS';

/**
 * Copy one exifr-parsed IFD block into the piexifjs-shaped target,
 * rewrapping `Rational` / `SRational` tag values from floats back into
 * the `[num, den]` tuple form piexif.dump() requires. Tags piexifjs
 * does not know about are dropped — emitting them would break piexif's
 * strict TAGS lookup.
 */
function copyIfdBlock(
  src: Record<number, unknown>,
  dst: Record<number, unknown>,
  group: PiexifTagTypeGroup,
): void {
  const groupTags = (
    piexif as unknown as { TAGS: Record<string, Record<number, { type: string }>> }
  ).TAGS[group];
  for (const key of Object.keys(src)) {
    const numericKey = Number(key);
    if (!Number.isFinite(numericKey)) continue;
    const meta = groupTags?.[numericKey];
    if (!meta) continue; // Unknown tag → skip, piexif.dump() would throw.
    const value = src[numericKey];
    if (value === undefined || value === null) continue;
    dst[numericKey] = coerceForPiexif(value, meta.type);
  }
}

/**
 * Coerce an exifr-parsed tag value into the shape piexifjs's
 * `_value_to_bytes` expects for the tag's declared type.
 */
function coerceForPiexif(value: unknown, type: string): unknown {
  if (type === 'Rational') {
    if (Array.isArray(value)) {
      // exifr may still hand back an array of floats for GPS DMS — wrap
      // each as a rational. Preserves structure.
      if (value.every((v) => typeof v === 'number')) {
        return (value as number[]).map((v) => floatToRational(v));
      }
      return value;
    }
    if (typeof value === 'number') {
      return floatToRational(value);
    }
    return value;
  }
  if (type === 'SRational') {
    if (Array.isArray(value)) {
      if (value.every((v) => typeof v === 'number')) {
        return (value as number[]).map((v) => floatToRational(v));
      }
      return value;
    }
    if (typeof value === 'number') {
      return floatToRational(value);
    }
    return value;
  }
  if (type === 'Byte' || type === 'Undefined') {
    // piexifjs packs Byte/Undefined as a string or array of numbers —
    // exifr's Uint8Array / number[] both work; leave as-is.
    if (value instanceof Uint8Array) return Array.from(value);
    return value;
  }
  // Ascii / Short / Long / SShort / SLong: primitive passthrough.
  return value;
}

async function blobToDataUri(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Build a base64 string chunk-by-chunk — `btoa(String.fromCharCode(...bytes))`
  // blows the call stack on multi-MB photos.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  const b64 =
    typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return `data:image/jpeg;base64,${b64}`;
}

function dataUriToBlob(dataUri: string): Blob {
  const commaIdx = dataUri.indexOf(',');
  if (commaIdx === -1) throw new Error('invalid data URI');
  const meta = dataUri.slice(0, commaIdx);
  const b64 = dataUri.slice(commaIdx + 1);
  const mimeMatch = /data:([^;]+)/.exec(meta);
  const mime = mimeMatch?.[1] ?? 'application/octet-stream';
  const binary =
    typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Inject the source EXIF dict into a JPEG blob. Returns a new Blob with
 * the APP1/EXIF segment written in. On any interop failure returns the
 * input blob unchanged — the pipeline must never fail an upload because
 * of best-effort metadata preservation.
 */
async function injectExifIntoJpeg(jpeg: Blob, exifDict: PiexifExifDict | null): Promise<Blob> {
  if (!exifDict) return jpeg;
  try {
    // The local `PiexifExifDict` shape matches what piexif.dump accepts
    // but the ambient type is loose (`Record<string, unknown>`); cast
    // through unknown to bridge the nominal mismatch.
    const exifBytes = piexif.dump(exifDict as unknown as Record<string, unknown>);
    const dataUri = await blobToDataUri(jpeg);
    const modified = piexif.insert(exifBytes, dataUri);
    return dataUriToBlob(modified);
  } catch {
    // Best-effort — if piexifjs rejects a value we'd rather ship the
    // JPEG without EXIF than abort the upload. The kickoff promise is
    // to preserve EXIF when possible; we log nothing here because the
    // pipeline is pure and the store's failure telemetry covers the
    // observable outcome.
    return jpeg;
  }
}

/**
 * Run the client-side upload pipeline for a single file.
 *
 * For photo MIME types (`image/jpeg`, `image/png`, `image/webp`,
 * `image/heic`):
 *   1. HEIC inputs are transcoded to JPEG via `heic-to/next`
 *      (OffscreenCanvas + Worker). EXIF is parsed from the source with
 *      `exifr` and injected into the JPEG with `piexifjs` so GPS
 *      (worker field-capture context, kickoff) survives the transcode.
 *   2. The original is downscaled to `imageMaxDimension` and re-encoded
 *      via `browser-image-compression` with `preserveExif: true`, so
 *      the EXIF from step 1 carries through the re-encode.
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

  // Step 1: HEIC → JPEG (lossy transcode) + EXIF re-injection so the
  // transcoded JPEG carries the same GPS/orientation the source had.
  // `heic-to/next` pushes decode off the main thread (Worker +
  // OffscreenCanvas), keeping the UI responsive on multi-MB captures.
  let workingFile: File | Blob = file;
  let mimeType = file.type;
  if (mimeType === 'image/heic') {
    try {
      const exifDict = await readExifForPiexif(file);
      const jpegBare = await heicTo({
        blob: file,
        type: 'image/jpeg',
        quality: ATTACHMENT_PIPELINE.imageQuality,
      });
      const jpegWithExif = await injectExifIntoJpeg(jpegBare, exifDict);
      workingFile = jpegWithExif;
      mimeType = 'image/jpeg';
    } catch {
      // HEIC transcode failed — fall back to the raw file; the server
      // whitelist permits HEIC so it can still land.
      workingFile = file;
      mimeType = file.type;
    }
  }

  // Step 2: downscale + re-encode original. `preserveExif: true` is the
  // switch that copies the APP1/EXIF segment from `workingFile` into
  // the re-encoded blob — for HEIC inputs that EXIF was injected above,
  // for native JPEGs it's the camera's original EXIF. GPS rides along.
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
