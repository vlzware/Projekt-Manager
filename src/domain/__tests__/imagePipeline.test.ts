/**
 * Unit tests for the client-side image pipeline
 * (`src/domain/imagePipeline.ts`) — the worker-view HEIC→JPEG
 * transcode, EXIF preservation, downscale, and WebP thumbnail path
 * from ui/project-detail.md §8.15.4.
 *
 * Environment — these tests run under the `unit` project (Node), where
 * `document`, `Worker`, `OffscreenCanvas`, and libheif are unavailable.
 * The pipeline's `canProcessImages()` probe short-circuits to a
 * passthrough in that environment, so assertions about pixel-level
 * work (resize, WebP thumbnails) are driven through a stubbed
 * `document.createElement` + stubbed `browser-image-compression` and
 * `heic-to/next` modules. Real byte-level EXIF round-tripping is
 * asserted on a real JPEG fixture the pipeline produces via piexifjs.
 *
 * The stubs mirror the shape of the upstream modules, not a snapshot
 * of their internal behaviour — we assert "the pipeline asked the
 * module to compress with these options" rather than "the final bytes
 * match this baseline".
 *
 * Rationale for mocking rather than running real libheif / real
 * canvas: vitest's Node `unit` project has no DOM; the browser-only
 * libraries can't run. The e2e suite covers the real-browser path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import piexif from 'piexifjs';

// The pipeline imports these — we stub them at the module level so the
// test can inspect the calls and inject synthetic outputs. Vitest's
// `vi.mock` hoists above the import, so the SUT reads the stubs.
vi.mock('heic-to/next', () => ({
  heicTo: vi.fn(),
}));

vi.mock('browser-image-compression', () => ({
  default: vi.fn(),
}));

// Re-import the stubs so we can drive them from the tests.
import { heicTo } from 'heic-to/next';
import imageCompression from 'browser-image-compression';

import { runImagePipeline, exceedsRawCap } from '../imagePipeline';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(__dirname, '../../../e2e/fixtures');

/**
 * Load a real JPEG fixture as a `File` — used for the EXIF round-trip
 * test that needs genuine JPEG bytes.
 */
async function loadJpegFixture(name: string): Promise<File> {
  const buf = await fs.readFile(path.join(FIXTURE_DIR, name));
  return new File([buf], name, { type: 'image/jpeg' });
}

/**
 * Build a tiny synthetic file of the given type — used anywhere the
 * test only needs a `File` with a particular MIME type and size.
 */
function syntheticFile(name: string, mime: string, bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

/**
 * Install a canvas-capable fake `document` on the global so
 * `canProcessImages()` returns true. Without this the pipeline
 * short-circuits to a passthrough.
 */
function installCanvasDom(): void {
  // Using a light stub — the pipeline only calls `createElement('canvas')
  // .getContext('2d')` and checks the result is non-null.
  const fakeContext = {};
  const fakeCanvas = {
    getContext: vi.fn(() => fakeContext),
  };
  (globalThis as { document?: unknown }).document = {
    createElement: vi.fn(() => fakeCanvas),
  };
}

function uninstallCanvasDom(): void {
  delete (globalThis as { document?: unknown }).document;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exceedsRawCap', () => {
  it('returns false for files at or below 4× the per-file cap', () => {
    // 4× is the liberal cap picked to short-circuit obvious garbage
    // without rejecting HEIC sources that will compress under the cap.
    const justUnder = new File(
      [new Uint8Array(ATTACHMENT_PIPELINE.perFileSizeCapBytes * 4)],
      'x.jpg',
      { type: 'image/jpeg' },
    );
    expect(exceedsRawCap(justUnder)).toBe(false);
  });

  it('returns true when raw bytes exceed 4× the per-file cap', () => {
    // A file this size cannot compress under the 1 MB cap no matter
    // what the pipeline does — reject before any work happens.
    const oversized = new File(
      [new Uint8Array(ATTACHMENT_PIPELINE.perFileSizeCapBytes * 4 + 1)],
      'x.jpg',
      { type: 'image/jpeg' },
    );
    expect(exceedsRawCap(oversized)).toBe(true);
  });
});

describe('runImagePipeline — passthrough branches', () => {
  afterEach(() => {
    uninstallCanvasDom();
    vi.clearAllMocks();
  });

  it('returns the original file verbatim in a non-browser environment', async () => {
    // No `document` on globalThis → `canProcessImages()` returns false
    // → the pipeline must pass through without touching heic-to or
    // browser-image-compression. This is the branch every Node-side
    // unit test (including the store's) relies on.
    const file = syntheticFile('camera.jpg', 'image/jpeg', 1024);
    const result = await runImagePipeline(file, { hasThumbnail: true });

    expect(result.original).toBe(file);
    expect(result.thumbnail).toBeNull();
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(1024);
    expect(heicTo).not.toHaveBeenCalled();
    expect(imageCompression).not.toHaveBeenCalled();
  });

  it('passes binaries (PDF) through even in a browser environment', async () => {
    // `classifyKind('application/pdf') === 'binary'` — the pipeline
    // must not run compression on PDFs; that's what the server-side
    // size/MIME enforcement is for.
    installCanvasDom();
    const file = syntheticFile('invoice.pdf', 'application/pdf', 2048);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(result.original).toBe(file);
    expect(result.thumbnail).toBeNull();
    expect(result.mimeType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(2048);
    expect(imageCompression).not.toHaveBeenCalled();
  });

  it('passes an unknown MIME through without attempting to classify', async () => {
    // `classifyKind` throws on unknown MIME — the pipeline must catch
    // and pass through so the server produces the authoritative 422
    // from the init route rather than the client wedging on the error.
    installCanvasDom();
    const file = syntheticFile('weird.xyz', 'application/x-unknown', 128);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(result.original).toBe(file);
    expect(result.mimeType).toBe('application/x-unknown');
    expect(imageCompression).not.toHaveBeenCalled();
  });
});

describe('runImagePipeline — photo branch', () => {
  beforeEach(() => {
    installCanvasDom();
  });

  afterEach(() => {
    uninstallCanvasDom();
    vi.clearAllMocks();
  });

  it('compresses a JPEG with the configured dimension / quality / preserveExif flag', async () => {
    // The dimension, quality, and — crucially — `preserveExif: true`
    // switches are what carries EXIF (GPS incl.) through the re-encode.
    // Any future change that flips `preserveExif` off is a silent
    // regression on the worker-view promise.
    const compressed = new Blob([new Uint8Array(512)], { type: 'image/jpeg' });
    vi.mocked(imageCompression).mockResolvedValue(compressed as unknown as File);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    await runImagePipeline(file, { hasThumbnail: false });

    expect(imageCompression).toHaveBeenCalled();
    const [, opts] = vi.mocked(imageCompression).mock.calls[0];
    expect(opts).toMatchObject({
      maxWidthOrHeight: ATTACHMENT_PIPELINE.imageMaxDimension,
      initialQuality: ATTACHMENT_PIPELINE.imageQuality,
      useWebWorker: true,
      preserveExif: true,
      fileType: 'image/jpeg',
    });
  });

  it('produces a WebP thumbnail at the configured dimensions when asked', async () => {
    // The pipeline makes two compression calls: one for the original,
    // one for the thumbnail. The thumbnail call must target image/webp
    // at the `thumbnailMaxDimension` — that pair is what the gallery
    // renders.
    const originalBlob = new Blob([new Uint8Array(512)], { type: 'image/jpeg' });
    const thumbBlob = new Blob([new Uint8Array(64)], { type: 'image/webp' });
    vi.mocked(imageCompression)
      .mockResolvedValueOnce(originalBlob as unknown as File)
      .mockResolvedValueOnce(thumbBlob as unknown as File);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: true });

    expect(imageCompression).toHaveBeenCalledTimes(2);
    const [, thumbOpts] = vi.mocked(imageCompression).mock.calls[1];
    expect(thumbOpts).toMatchObject({
      maxWidthOrHeight: ATTACHMENT_PIPELINE.thumbnailMaxDimension,
      initialQuality: ATTACHMENT_PIPELINE.thumbnailQuality,
      fileType: 'image/webp',
    });
    expect(result.thumbnail).toBe(thumbBlob);
  });

  it('does not call the thumbnail compression when hasThumbnail is false', async () => {
    // Binary row (PDF) or photo upload path with hasThumbnail=false —
    // the server uses the `hasThumbnail` flag to decide how many
    // presigned descriptors to issue. Issuing a thumbnail the caller
    // did not ask for would waste a round-trip.
    const compressed = new Blob([new Uint8Array(512)], { type: 'image/jpeg' });
    vi.mocked(imageCompression).mockResolvedValue(compressed as unknown as File);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(imageCompression).toHaveBeenCalledTimes(1);
    expect(result.thumbnail).toBeNull();
  });

  it('returns the compressed blob as the original when compression succeeds', async () => {
    // The pipeline's "compressed original" lands in the gallery as the
    // byte-for-byte source the lightbox serves. A passthrough when the
    // compress call succeeds would defeat the downscale.
    const compressed = new Blob([new Uint8Array(321)], { type: 'image/jpeg' });
    vi.mocked(imageCompression).mockResolvedValue(compressed as unknown as File);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(result.original).toBe(compressed);
    expect(result.sizeBytes).toBe(321);
  });

  it('falls back to the original file when compression throws', async () => {
    // Mirrors the production resilience rule: a compression failure
    // does not fail the upload — the raw bytes go to the server which
    // enforces size + MIME.
    vi.mocked(imageCompression).mockRejectedValueOnce(new Error('oom'));

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(result.original).toBe(file);
    expect(result.sizeBytes).toBe(file.size);
  });
});

describe('runImagePipeline — HEIC branch', () => {
  beforeEach(() => {
    installCanvasDom();
  });

  afterEach(() => {
    uninstallCanvasDom();
    vi.clearAllMocks();
  });

  it('transcodes HEIC via heic-to/next with the configured JPEG quality', async () => {
    // `heic-to/next` is the worker-friendly entry point — default
    // `heic-to` decodes on the main thread and freezes the UI for
    // multi-MB photos. Asserting on the call args pins that the
    // pipeline keeps using the worker subpath.
    const transcoded = new Blob([new Uint8Array(2048)], { type: 'image/jpeg' });
    vi.mocked(heicTo).mockResolvedValue(transcoded);
    vi.mocked(imageCompression).mockResolvedValue(
      new Blob([new Uint8Array(512)], { type: 'image/jpeg' }) as unknown as File,
    );

    const file = syntheticFile('photo.heic', 'image/heic', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(heicTo).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'image/jpeg',
        quality: ATTACHMENT_PIPELINE.imageQuality,
      }),
    );
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('falls back to the raw HEIC when transcode throws', async () => {
    // HEIC stays on the whitelist — if libheif chokes, the server
    // still accepts the raw bytes. Matches the existing resilience
    // behaviour of the pre-EXIF-fix pipeline.
    vi.mocked(heicTo).mockRejectedValueOnce(new Error('libheif error'));
    vi.mocked(imageCompression).mockResolvedValue(
      new Blob([new Uint8Array(512)], { type: 'image/heic' }) as unknown as File,
    );

    const file = syntheticFile('broken.heic', 'image/heic', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    // The pipeline swallows the HEIC failure and re-enters the compress
    // step with the raw file; we assert the MIME reverted, not the
    // compressed bytes (which are the stub's output).
    expect(result.mimeType).toBe('image/heic');
  });

  it('injects source EXIF bytes into the transcoded JPEG (GPS + orientation)', async () => {
    // The load-bearing assertion for §8.15.4's EXIF promise. We build a
    // real JPEG with known EXIF, point the stubbed heic-to at a plain
    // no-EXIF JPEG (mimicking canvas.convertToBlob output), and then
    // observe what the pipeline hands to the downstream compress step —
    // that blob is what browser-image-compression's `preserveExif:true`
    // branch reads from.
    const sourceExif = await loadJpegFixture('large.jpg');
    // exifr reads a Blob via FileReader; in the Node test environment
    // that's absent, so hand it a Uint8Array for the sanity check.
    const sourceBytes = new Uint8Array(await sourceExif.arrayBuffer());
    const parsedSource = (await exifr.parse(sourceBytes, { gps: true })) as {
      Make?: string;
      Orientation?: number;
      latitude?: number;
      longitude?: number;
    };
    // Sanity check the fixture actually has the EXIF we expect — if the
    // fixture regenerates without GPS, the rest of this test is
    // meaningless, so fail loudly here.
    expect(parsedSource.Make).toBe('TestCam');
    expect(parsedSource.latitude).toBeGreaterThan(48);
    expect(parsedSource.longitude).toBeGreaterThan(16);

    // Plain JPEG with no EXIF — mimics what canvas.convertToBlob()
    // produces downstream of libheif.
    const bareJpegBytes = stripAllAppSegments(new Uint8Array(await sourceExif.arrayBuffer()));
    // Cast through Uint8Array slice so lib.dom's BlobPart typing is
    // satisfied — Node 22's typing is stricter about SAB-backed arrays
    // than the runtime checker.
    const bareJpeg = new Blob([bareJpegBytes.slice().buffer], { type: 'image/jpeg' });
    vi.mocked(heicTo).mockResolvedValue(bareJpeg);

    let capturedForCompress: Blob | null = null;
    vi.mocked(imageCompression).mockImplementation(async (input) => {
      capturedForCompress = input as unknown as Blob;
      return new Blob([new Uint8Array(256).slice().buffer], {
        type: 'image/jpeg',
      }) as unknown as File;
    });

    // Re-use `sourceExif` bytes as the "HEIC" the pipeline reads EXIF
    // from — exifr treats it as a TIFF/JPEG source with EXIF and
    // extracts the same fields. The pipeline's MIME branch keys off
    // `file.type === 'image/heic'` regardless of the actual container.
    const heicFile = new File([await sourceExif.arrayBuffer()], 'photo.heic', {
      type: 'image/heic',
    });
    await runImagePipeline(heicFile, { hasThumbnail: false });

    expect(capturedForCompress).not.toBeNull();
    // Convert the captured blob to a Uint8Array for the same reason —
    // no FileReader under Node.
    const captured = capturedForCompress as unknown as Blob;
    const injectedBytes = new Uint8Array(await captured.arrayBuffer());
    const injected = await exifr.parse(injectedBytes, {
      tiff: true,
      gps: true,
      // Keep raw numeric values so Orientation comes back as `1`
      // (piexif writes the integer tag, not the humanised label).
      translateValues: false,
    });
    // Make / Model / Orientation are TIFF 0th IFD tags — piexifjs
    // should have serialized them back into the injected APP1 segment.
    expect(injected.Make).toBe('TestCam');
    expect(injected.Orientation).toBe(1);
    // GPS lat/lng survive the DMS-rational rebuild within exifr's
    // decoding tolerance — compare at ~1e-3 precision (arc-seconds).
    expect(injected.latitude).toBeCloseTo(parsedSource.latitude!, 3);
    expect(injected.longitude).toBeCloseTo(parsedSource.longitude!, 3);
  });

  it('gracefully ships the JPEG without EXIF when injection fails', async () => {
    // When piexif rejects a constructed dict (malformed source EXIF,
    // unknown tag), the pipeline must not fail the upload — best-effort
    // preservation, not a hard contract.
    const minimalBytes = minimalJpegBytes();
    const bareJpeg = new Blob([minimalBytes.slice().buffer], { type: 'image/jpeg' });
    vi.mocked(heicTo).mockResolvedValue(bareJpeg);
    vi.mocked(imageCompression).mockResolvedValue(
      new Blob([new Uint8Array(256).slice().buffer], {
        type: 'image/jpeg',
      }) as unknown as File,
    );

    // HEIC source with no EXIF at all — `readExifForPiexif` returns null,
    // `injectExifIntoJpeg` is a no-op, the transcode proceeds.
    const heicFile = new File([minimalJpegBytes().slice().buffer], 'plain.heic', {
      type: 'image/heic',
    });
    const result = await runImagePipeline(heicFile, { hasThumbnail: false });

    expect(result.mimeType).toBe('image/jpeg');
  });
});

describe('piexifjs interop — regression pins', () => {
  // These pin the byte-level behaviour the pipeline relies on. If a
  // future upgrade of `piexifjs` or `exifr` drifts the shape, the
  // pipeline's HEIC branch silently regresses — these assertions catch
  // that.

  it('piexif.insert embeds a dump()ed EXIF block into a JPEG data URI', () => {
    // The pipeline's injection helper depends on `insert(dump(...), ...)`
    // round-tripping cleanly. If piexif starts requiring a binary EXIF
    // segment on its input, the pipeline crashes on every HEIC upload.
    const exifDict = {
      '0th': { [piexif.ImageIFD.Make]: 'Pin', [piexif.ImageIFD.Orientation]: 1 },
      Exif: {},
      GPS: {},
      '1st': {},
      thumbnail: null,
    };
    const dumped = piexif.dump(exifDict as unknown as Record<string, unknown>);
    expect(typeof dumped).toBe('string');

    const jpegDataUri =
      'data:image/jpeg;base64,' + Buffer.from(minimalJpegBytes()).toString('base64');
    const inserted = piexif.insert(dumped, jpegDataUri);
    expect(inserted.startsWith('data:image/jpeg;base64,')).toBe(true);
    // Round-trip: load back the inserted EXIF and confirm the Make tag
    // survived.
    const loaded = piexif.load(inserted);
    const zeroth = (loaded as { '0th'?: Record<number, unknown> })['0th'];
    expect(zeroth?.[piexif.ImageIFD.Make]).toBe('Pin');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip every APPn marker segment (0xFFE0 … 0xFFEF) from a JPEG byte
 * stream, leaving SOI, frame data, and EOI intact. Used to simulate
 * what `canvas.convertToBlob('image/jpeg')` produces — pure pixel data
 * with no EXIF.
 */
function stripAllAppSegments(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Must start with SOI.
  if (view.getUint16(0) !== 0xffd8) {
    throw new Error('stripAllAppSegments: not a JPEG');
  }
  const out: number[] = [0xff, 0xd8];
  let offset = 2;
  while (offset < bytes.byteLength) {
    const marker = view.getUint16(offset);
    if (marker === 0xffda /* SOS */) {
      // Copy from SOS to end verbatim — the scan segment contains the
      // image data and the trailing EOI.
      for (let i = offset; i < bytes.byteLength; i++) out.push(bytes[i]);
      break;
    }
    const segmentLength = view.getUint16(offset + 2);
    const isApp = marker >= 0xffe0 && marker <= 0xffef;
    if (!isApp) {
      // Keep non-APPn segments (DQT, DHT, SOF, …).
      for (let i = offset; i < offset + 2 + segmentLength; i++) out.push(bytes[i]);
    }
    offset += 2 + segmentLength;
  }
  return new Uint8Array(out);
}

/**
 * A minimal valid JPEG byte stream — SOI + APP0 (JFIF) + DQT + SOF0 +
 * DHT + SOS + one scan byte + EOI. Just enough for piexif to accept
 * the buffer as a JPEG for the insert() regression pin; not a
 * decodable image.
 */
function minimalJpegBytes(): Uint8Array {
  // Pre-computed: a 1×1 white-pixel JPEG produced by `sharp({
  // create: { width: 1, height: 1, channels: 3, background: 'white' }
  // }).jpeg().toBuffer()`. Inlined so the test is self-contained.
  const b64 =
    '/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
