/**
 * Unit tests for the client-side image pipeline
 * (`src/domain/imagePipeline.ts`) — downscale + re-encode + WebP
 * thumbnail path from ui/project-detail.md §8.15.4.
 *
 * Environment — these tests run under the `unit` project (Node), where
 * `document` is unavailable. The pipeline's `canProcessImages()` probe
 * short-circuits to a passthrough in that environment, so assertions
 * about pixel-level work (resize, WebP thumbnails) are driven through
 * a stubbed `document.createElement` + stubbed `browser-image-compression`.
 *
 * The stubs mirror the shape of the upstream module, not a snapshot of
 * its internal behaviour — we assert "the pipeline asked the module to
 * compress with these options" rather than "the final bytes match this
 * baseline".
 *
 * Rationale for mocking rather than running real canvas: vitest's Node
 * `unit` project has no DOM; `browser-image-compression` can't run.
 * The e2e suite covers the real-browser path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The pipeline imports this — we stub it at the module level so the
// test can inspect the calls and inject synthetic outputs. Vitest's
// `vi.mock` hoists above the import, so the SUT reads the stub.
vi.mock('browser-image-compression', () => ({
  default: vi.fn(),
}));

// Re-import the stub so we can drive it from the tests.
import imageCompression from 'browser-image-compression';

import { runImagePipeline, exceedsRawCap } from '../imagePipeline';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  it('returns false for files at or below 30× the per-file cap', () => {
    // 30× is the liberal cap picked to short-circuit obvious garbage
    // without rejecting sources that will compress under the cap.
    // Modern 50 MP phone sensors emit 10–15 MB JPEGs; the earlier 4×
    // ceiling tripped on ordinary field captures before the compressor
    // ever ran.
    const justUnder = new File(
      [new Uint8Array(ATTACHMENT_PIPELINE.perFileSizeCapBytes * 30)],
      'x.jpg',
      { type: 'image/jpeg' },
    );
    expect(exceedsRawCap(justUnder)).toBe(false);
  });

  it('returns true when raw bytes exceed 30× the per-file cap', () => {
    // A file this size cannot compress under the 1 MB cap no matter
    // what the pipeline does — reject before any work happens.
    const oversized = new File(
      [new Uint8Array(ATTACHMENT_PIPELINE.perFileSizeCapBytes * 30 + 1)],
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
    // → the pipeline must pass through without touching
    // browser-image-compression. This is the branch every Node-side
    // unit test (including the store's) relies on.
    const file = syntheticFile('camera.jpg', 'image/jpeg', 1024);
    const result = await runImagePipeline(file, { hasThumbnail: true });

    expect(result.original).toBe(file);
    expect(result.thumbnail).toBeNull();
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(1024);
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

  it('passes an unknown MIME (incl. unsupported image/heic) through without classifying', async () => {
    // `classifyKind` throws on unknown MIME — the pipeline must catch
    // and pass through so the server produces the authoritative 422
    // from the init route rather than the client wedging on the error.
    // Covers HEIC too: HEIC is deliberately off the whitelist, so a
    // HEIC file that slips past the UploadCta's MIME gate reaches the
    // server as a raw blob and gets rejected there.
    installCanvasDom();
    for (const mime of ['application/x-unknown', 'image/heic']) {
      const file = syntheticFile('weird', mime, 128);
      const result = await runImagePipeline(file, { hasThumbnail: false });
      expect(result.original).toBe(file);
      expect(result.mimeType).toBe(mime);
      expect(imageCompression).not.toHaveBeenCalled();
    }
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

  it('passes maxSizeMB derived from the per-file cap so the library iterates to fit', async () => {
    // Without maxSizeMB the library does one-shot q=0.82 compression,
    // which for high-detail phone JPEGs commonly lands above the 1 MB
    // cap. Iterating to the target is the fix for the "Datei zu groß"
    // surfaced on otherwise-normal camera captures.
    const compressed = new Blob([new Uint8Array(512)], { type: 'image/jpeg' });
    vi.mocked(imageCompression).mockResolvedValue(compressed as unknown as File);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    await runImagePipeline(file, { hasThumbnail: false });

    const [, opts] = vi.mocked(imageCompression).mock.calls[0];
    expect(opts).toMatchObject({
      maxSizeMB: ATTACHMENT_PIPELINE.perFileSizeCapBytes / (1024 * 1024),
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

  it('throws IMAGE_PROCESSING_FAILED when original compression throws with an unrelated error', async () => {
    // A compression failure used to silently pass the raw file through,
    // which then tripped the post-pipeline size cap and surfaced as
    // "Datei zu groß" — a misleading diagnosis of a different failure
    // (canvas OOM, worker crash, decode bug). The pipeline now throws
    // a tagged error so the store can map it to
    // `uploadImageProcessingFailed`, keeping the two causes
    // distinguishable in logs and in the UI banner.
    //
    // Scoped to non-EXIF errors — the EXIF-copy bug in
    // browser-image-compression@2.0.2 has its own retry-without-exif
    // fallback (next test).
    vi.mocked(imageCompression).mockRejectedValueOnce(new Error('oom'));

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    await expect(runImagePipeline(file, { hasThumbnail: false })).rejects.toThrow(
      'IMAGE_PROCESSING_FAILED',
    );
    // No retry for unrelated errors — a single call proves the
    // fallback path is scoped and won't mask decode/OOM bugs.
    expect(imageCompression).toHaveBeenCalledTimes(1);
  });

  it('retries without preserveExif when the library rejects the EXIF segment', async () => {
    // browser-image-compression@2.0.2's EXIF copier rejects some
    // legitimate phone captures (e.g. Orientation encoded as LONG
    // instead of SHORT). The pipeline retries with preserveExif=false
    // so the photo still uploads; affected captures lose EXIF/GPS for
    // that photo, but the alternative is refusing the upload entirely.
    // The library rejects with a raw string, not an Error — matches
    // what we observe from the real library.
    const compressed = new Blob([new Uint8Array(321)], { type: 'image/jpeg' });
    vi.mocked(imageCompression)
      .mockRejectedValueOnce('Orientation data type is invalid')
      .mockResolvedValueOnce(compressed as unknown as File);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(imageCompression).toHaveBeenCalledTimes(2);
    const [, firstOpts] = vi.mocked(imageCompression).mock.calls[0];
    const [, secondOpts] = vi.mocked(imageCompression).mock.calls[1];
    expect(firstOpts).toMatchObject({ preserveExif: true });
    // The retry must flip preserveExif while keeping every other option
    // stable — same dimension cap, quality, fileType — so the output
    // still fits the post-pipeline size check.
    expect(secondOpts).toMatchObject({
      preserveExif: false,
      maxWidthOrHeight: ATTACHMENT_PIPELINE.imageMaxDimension,
      initialQuality: ATTACHMENT_PIPELINE.imageQuality,
      fileType: 'image/jpeg',
    });
    expect(result.original).toBe(compressed);
    expect(result.sizeBytes).toBe(321);
  });

  it('throws IMAGE_PROCESSING_FAILED when the EXIF retry also fails', async () => {
    // Retry is a best-effort pass — if the library fails again on the
    // second call (any reason), the pipeline must still surface the
    // tagged error so the store shows the "Bildbearbeitung fehlgeschlagen"
    // banner. Silent passthrough would trip the post-pipeline size cap.
    vi.mocked(imageCompression)
      .mockRejectedValueOnce('Orientation data type is invalid')
      .mockRejectedValueOnce(new Error('decode failed'));

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    await expect(runImagePipeline(file, { hasThumbnail: false })).rejects.toThrow(
      'IMAGE_PROCESSING_FAILED',
    );
    expect(imageCompression).toHaveBeenCalledTimes(2);
  });
});
