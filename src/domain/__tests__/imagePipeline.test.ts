/**
 * Unit tests for the client-side image pipeline
 * (`src/domain/imagePipeline.ts`) — downscale + re-encode + WebP
 * thumbnail path from ui/project-detail.md §8.15.4.
 *
 * Environment — these tests run under the `unit` project (Node), where
 * `document` is unavailable. The pipeline's `canProcessImages()` probe
 * short-circuits to a passthrough in that environment, so assertions
 * about pixel-level work (resize, WebP thumbnails) are driven through
 * a stubbed `document.createElement` + stubbed `@uploadcare/image-shrink`.
 *
 * The stubs mirror the shape of the upstream module, not a snapshot of
 * its internal behaviour — we assert "the pipeline asked the module to
 * shrink with these options" rather than "the final bytes match this
 * baseline". Real-browser EXIF preservation is covered by the e2e
 * fixture test that round-trips a non-conforming-Orientation JPEG.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The pipeline imports this — we stub it at the module level so the
// test can inspect the calls and inject synthetic outputs. Vitest's
// `vi.mock` hoists above the import, so the SUT reads the stub.
vi.mock('@uploadcare/image-shrink', () => ({
  shrinkFile: vi.fn(),
}));

// Re-import the stub so we can drive it from the tests.
import { shrinkFile } from '@uploadcare/image-shrink';

import { runImagePipeline, exceedsRawCap } from '../imagePipeline';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function syntheticFile(name: string, mime: string, bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

/**
 * Install a canvas-capable fake `document` + `Image` + `URL` on the
 * global so `canProcessImages()` returns true and the thumbnail path
 * can decode-and-encode without a real browser. The stubs are minimal:
 * the canvas only needs `getContext` non-null and a `toBlob` that
 * synchronously yields a fixed blob; the Image fires `onload` next
 * tick so the await in `loadImageElement` resolves.
 */
function installCanvasDom(): void {
  const fakeContext = { drawImage: vi.fn() };
  const fakeCanvas = {
    getContext: vi.fn(() => fakeContext),
    toBlob: vi.fn((cb: BlobCallback, type?: string) =>
      cb(new Blob([new Uint8Array(64)], { type: type ?? 'image/webp' })),
    ),
    width: 0,
    height: 0,
  };
  (globalThis as { document?: unknown }).document = {
    createElement: vi.fn(() => fakeCanvas),
  };
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 4032;
    naturalHeight = 3024;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  (globalThis as { Image?: unknown }).Image = FakeImage;
  (globalThis as { URL?: unknown }).URL = {
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  };
}

function uninstallCanvasDom(): void {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { Image?: unknown }).Image;
  delete (globalThis as { URL?: unknown }).URL;
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
    // → the pipeline must pass through without touching the shrinker.
    const file = syntheticFile('camera.jpg', 'image/jpeg', 1024);
    const result = await runImagePipeline(file, { hasThumbnail: true });

    expect(result.original).toBe(file);
    expect(result.thumbnail).toBeNull();
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(1024);
    expect(shrinkFile).not.toHaveBeenCalled();
  });

  it('passes binaries (PDF) through even in a browser environment', async () => {
    installCanvasDom();
    const file = syntheticFile('invoice.pdf', 'application/pdf', 2048);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(result.original).toBe(file);
    expect(result.thumbnail).toBeNull();
    expect(result.mimeType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(2048);
    expect(shrinkFile).not.toHaveBeenCalled();
  });

  it('passes an unknown MIME (incl. unsupported image/heic) through without classifying', async () => {
    installCanvasDom();
    for (const mime of ['application/x-unknown', 'image/heic']) {
      const file = syntheticFile('weird', mime, 128);
      const result = await runImagePipeline(file, { hasThumbnail: false });
      expect(result.original).toBe(file);
      expect(result.mimeType).toBe(mime);
      expect(shrinkFile).not.toHaveBeenCalled();
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

  it('shrinks a JPEG with the configured dimension / quality on the first attempt', async () => {
    // The dimension and quality switches drive the size of the output;
    // EXIF preservation is the library's structural guarantee (byte-
    // splice in `replaceJpegChunk`) and is asserted end-to-end via the
    // browser fixture test, not here.
    const compressed = new Blob([new Uint8Array(512)], { type: 'image/jpeg' });
    vi.mocked(shrinkFile).mockResolvedValue(compressed);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    await runImagePipeline(file, { hasThumbnail: false });

    expect(shrinkFile).toHaveBeenCalledTimes(1);
    const [, opts] = vi.mocked(shrinkFile).mock.calls[0];
    expect(opts).toEqual({
      size: ATTACHMENT_PIPELINE.imageMaxDimension,
      quality: ATTACHMENT_PIPELINE.imageQuality,
    });
  });

  it('iterates with reduced quality / dimension when the first attempt exceeds the cap', async () => {
    // High-detail phone JPEGs sometimes land above the 1 MB cap on the
    // first pass at q=0.82. The pipeline knocks down quality first
    // (less destructive than dimension reduction), then dimension. Six
    // attempts is the bound; here the second attempt fits.
    const oversized = new Blob([new Uint8Array(ATTACHMENT_PIPELINE.perFileSizeCapBytes + 1)], {
      type: 'image/jpeg',
    });
    const fits = new Blob([new Uint8Array(512)], { type: 'image/jpeg' });
    vi.mocked(shrinkFile).mockResolvedValueOnce(oversized).mockResolvedValueOnce(fits);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(shrinkFile).toHaveBeenCalledTimes(2);
    const [, firstOpts] = vi.mocked(shrinkFile).mock.calls[0];
    const [, secondOpts] = vi.mocked(shrinkFile).mock.calls[1];
    expect(firstOpts).toEqual({
      size: ATTACHMENT_PIPELINE.imageMaxDimension,
      quality: ATTACHMENT_PIPELINE.imageQuality,
    });
    // Second attempt: same dimension, quality knocked down. The exact
    // ratio is implementation detail (factor table); what matters is
    // that quality dropped and dimension didn't yet.
    expect(secondOpts.size).toBe(ATTACHMENT_PIPELINE.imageMaxDimension);
    expect(secondOpts.quality).toBeLessThan(ATTACHMENT_PIPELINE.imageQuality);
    expect(result.original).toBe(fits);
    expect(result.sizeBytes).toBe(512);
  });

  it('throws IMAGE_PROCESSING_FAILED when no attempt fits under the cap', async () => {
    // Every attempt over the cap → exhaust the table → throw the tagged
    // error. The store maps it to "Bildbearbeitung fehlgeschlagen". A
    // silent passthrough would trip the post-pipeline size check and
    // mis-report as "Datei zu groß" — a misleading diagnosis.
    const oversized = new Blob([new Uint8Array(ATTACHMENT_PIPELINE.perFileSizeCapBytes + 1)], {
      type: 'image/jpeg',
    });
    vi.mocked(shrinkFile).mockResolvedValue(oversized);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    await expect(runImagePipeline(file, { hasThumbnail: false })).rejects.toThrow(
      'IMAGE_PROCESSING_FAILED',
    );
    // Six attempts is the iteration bound — bumping this means the
    // table grew and tests should be revisited deliberately.
    expect(shrinkFile).toHaveBeenCalledTimes(6);
  });

  it('produces a WebP thumbnail at the configured dimension when asked', async () => {
    // The thumbnail is a separate canvas → toBlob('image/webp') call,
    // not a `shrinkFile` invocation: shrinkFile outputs JPEG/PNG only,
    // and WebP at small sizes is the deliberate format for the gallery
    // (better compression than JPEG at thumbnail dimensions).
    const compressed = new Blob([new Uint8Array(512)], { type: 'image/jpeg' });
    vi.mocked(shrinkFile).mockResolvedValue(compressed);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: true });

    expect(shrinkFile).toHaveBeenCalledTimes(1);
    expect(result.thumbnail).toBeInstanceOf(Blob);
    expect(result.thumbnail?.type).toBe('image/webp');
  });

  it('does not encode a thumbnail when hasThumbnail is false', async () => {
    // Binary row (PDF) or photo upload path with hasThumbnail=false —
    // the server uses the `hasThumbnail` flag to decide how many
    // presigned descriptors to issue. Encoding one the caller did not
    // ask for would waste a round-trip.
    const compressed = new Blob([new Uint8Array(512)], { type: 'image/jpeg' });
    vi.mocked(shrinkFile).mockResolvedValue(compressed);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(result.thumbnail).toBeNull();
  });

  it('returns the shrunk blob as the original when shrink succeeds', async () => {
    // A passthrough when the shrink call succeeds would defeat the
    // downscale; the lightbox would serve the multi-MB raw source.
    const compressed = new Blob([new Uint8Array(321)], { type: 'image/jpeg' });
    vi.mocked(shrinkFile).mockResolvedValue(compressed);

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    const result = await runImagePipeline(file, { hasThumbnail: false });

    expect(result.original).toBe(compressed);
    expect(result.sizeBytes).toBe(321);
  });

  it('throws IMAGE_PROCESSING_FAILED when the shrinker rejects (decode/OOM)', async () => {
    // A shrink failure used to silently pass the raw file through,
    // which then tripped the post-pipeline size cap and surfaced as
    // "Datei zu groß" — a misleading diagnosis of a different failure
    // (canvas OOM, decode bug). The pipeline now throws a tagged error
    // so the store maps it to `uploadImageProcessingFailed`, keeping
    // the two causes distinguishable in logs and in the UI banner.
    vi.mocked(shrinkFile).mockRejectedValueOnce(new Error('oom'));

    const file = syntheticFile('photo.jpg', 'image/jpeg', 4096);
    await expect(runImagePipeline(file, { hasThumbnail: false })).rejects.toThrow(
      'IMAGE_PROCESSING_FAILED',
    );
  });
});
