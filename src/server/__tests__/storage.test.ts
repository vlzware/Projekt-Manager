/**
 * API integration test: Object storage module.
 *
 * Test AT-16 from the test specification (verification.md §16.3).
 *
 * This tests the object storage module boundary directly (not through
 * HTTP routes). The module encapsulates upload/download/hide operations
 * against an S3-compatible object storage backend.
 *
 * Per architecture.md §11.4, the module must support:
 *   - Upload (key, data, content type) -> stored reference
 *   - Download (key) -> data stream
 *   - Hide (key) -> success/failure (DeleteObject without VersionId on a
 *     versioned bucket — writes a delete marker, not a destruction;
 *     ADR-0022)
 *   - Get signed/temporary access URL (key, expiry) -> URL
 *
 * This test runs against real object storage infrastructure.
 * It requires valid storage credentials in the test environment.
 *
 * Run with:
 *   STORAGE_ENDPOINT=http://localhost:9000 \
 *   STORAGE_BUCKET=projekt-manager-test \
 *   STORAGE_ACCESS_KEY=minioadmin \
 *   STORAGE_SECRET_KEY=minioadmin \
 *   npx vitest run src/server/__tests__/storage.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createStorageClient, StorageObjectNotFoundError } from '../../server/storage/client.js';
import type { AttachmentStorageClient } from '../../server/storage/client.js';

/**
 * STORAGE_* env vars are required. If they are not set, this file fails loud
 * at `beforeAll` instead of silently reporting green. The storage module is
 * a core boundary of the architecture (architecture.md §11.4) and whether it
 * is wired up correctly is not optional state — it must be observable from
 * CI. Running tests that skip themselves on missing config teaches you
 * nothing about whether the module works.
 *
 * Whether the endpoint points at real S3 or a local MinIO is a deployment
 * choice, not a test concern — either way the env must be set.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Storage tests require ${name} to be set. ` +
        'STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, and STORAGE_SECRET_KEY ' +
        'must all be present. Point them at your S3-compatible backend ' +
        '(e.g. MinIO at http://localhost:9000 in local dev). ' +
        'Silent skipping is not allowed — see file header.',
    );
  }
  return value;
}

describe('Object Storage Module', () => {
  let storage: AttachmentStorageClient;

  beforeAll(() => {
    storage = createStorageClient({
      endpoint: requireEnv('STORAGE_ENDPOINT'),
      bucket: requireEnv('STORAGE_BUCKET'),
      accessKey: requireEnv('STORAGE_ACCESS_KEY'),
      secretKey: requireEnv('STORAGE_SECRET_KEY'),
      region: process.env.STORAGE_REGION ?? 'us-east-1',
    });
  });

  // ---------------------------------------------------------------
  // AT-16: Object storage module can upload a file, retrieve it,
  //        and verify the retrieved contents match the original
  // ---------------------------------------------------------------
  //
  // Test isolation rationale:
  // Each test owns its own testKey and performs its own setup (upload,
  // and in the case of the post-delete miss test, upload + delete).
  // A previous version of this block shared a single describe-scoped
  // testKey across all five tests, which created implicit ordering
  // dependencies: if the upload test failed, the remaining tests all
  // failed with misleading "not found" errors, hiding the real cause.
  // Sharing state also broke `--grep` / `--testNamePattern` filtering
  // for any single test and collapsed what should be independent
  // assertions into one compound test split across `it` blocks.
  //
  // The cost is a few extra uploads per run. Storage tests are
  // integration-level and not performance-critical — isolation wins.
  // Do not "optimize" this back into a shared key.
  // AC-40 [crit]
  describe('AT-16: Upload, retrieve, and verify', () => {
    const testContent = Buffer.from(
      'AT-16 Testdatei: Projekt-Manager Objekt-Speicher Integrationstest.',
      'utf-8',
    );
    const testContentType = 'text/plain';

    let testKey: string;

    beforeEach(() => {
      // Math.random() guards against Date.now() collisions when tests
      // run in the same millisecond (parallel workers, fast machines).
      testKey = `test/at-16-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
    });

    afterEach(async () => {
      // Best-effort cleanup so leftover objects don't accumulate in the
      // test bucket. Errors are swallowed: the object may already have
      // been deleted by the test itself (e.g. tests 4 and 5), or the
      // upload may have never happened (e.g. a failed upload in test 1).
      try {
        await storage.hide(testKey);
      } catch {
        // ignore — cleanup is best-effort
      }
    });

    it('uploads a file without error', async () => {
      const result = await storage.upload(testKey, testContent, testContentType);
      expect(result).toBeDefined();
      expect(result.key).toBe(testKey);
    });

    it('retrieves the uploaded file with matching contents', async () => {
      // Own upload: this test verifies retrieval fidelity, not ordering.
      await storage.upload(testKey, testContent, testContentType);

      const downloaded = await storage.download(testKey);
      expect(Buffer.isBuffer(downloaded.data) || downloaded.data instanceof Uint8Array).toBe(true);
      expect(Buffer.from(downloaded.data).toString('utf-8')).toBe(testContent.toString('utf-8'));
      expect(downloaded.contentType).toBe(testContentType);
    });

    it('generates a signed URL for the uploaded file', async () => {
      // Own upload: this test verifies signed URL generation, independent
      // of whether any earlier test uploaded something.
      await storage.upload(testKey, testContent, testContentType);

      const url = await storage.getSignedUrl(testKey, 60);
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^https?:\/\//);
    });

    it('hides the uploaded file', async () => {
      // Own upload: hide needs something to hide. Setup, not ordering.
      await storage.upload(testKey, testContent, testContentType);

      await expect(storage.hide(testKey)).resolves.not.toThrow();
    });

    it('download after hide returns not-found or throws', async () => {
      // Full setup: upload then hide, so the assertion under test is
      // purely "download of a hidden key fails". No reliance on any
      // other test having run first.
      await storage.upload(testKey, testContent, testContentType);
      await storage.hide(testKey);

      await expect(storage.download(testKey)).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // #48 — health probe support: ping() verifies bucket reachability
  // ---------------------------------------------------------------
  describe('ping()', () => {
    it('resolves when the configured bucket is reachable', async () => {
      await expect(storage.ping()).resolves.not.toThrow();
    });

    it('rejects when the bucket does not exist', async () => {
      const bogusStorage = createStorageClient({
        endpoint: requireEnv('STORAGE_ENDPOINT'),
        bucket: 'definitely-not-a-real-bucket-xyz-' + Date.now(),
        accessKey: requireEnv('STORAGE_ACCESS_KEY'),
        secretKey: requireEnv('STORAGE_SECRET_KEY'),
        region: process.env.STORAGE_REGION ?? 'us-east-1',
      });
      await expect(bogusStorage.ping()).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------
  // copyFromVersion() — restore primitive (ADR-0022, AC-234).
  //
  // Provider-divergent behaviour on an unaddressable source version is
  // the reason for the HEAD-with-versionId probe in `copyFromVersion`:
  // AWS / MinIO surface 404 NoSuchVersion, but B2 surfaces 500
  // InternalError on CopyObject (still 4xx on HEAD). The probe is what
  // lets the restore caller distinguish "bytes are gone" (4xx → 410
  // GONE) from a genuine outage (5xx bubble) — without it, B2's 500
  // InternalError fell through the global handler as 500 SERVER_ERROR.
  //
  // These integration tests exercise the contract on MinIO. Every 4xx
  // shape MinIO can return for an unaddressable version is the same
  // shape the probe must catch on B2; the cross-provider asymmetry is
  // narrowed to the same `StorageObjectNotFoundError` outcome here.
  // ---------------------------------------------------------------
  describe('copyFromVersion()', () => {
    let testKey: string;

    beforeEach(() => {
      testKey = `test/copy-from-version-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`;
    });

    afterEach(async () => {
      try {
        await storage.hide(testKey);
      } catch {
        // best-effort
      }
    });

    it('throws StorageObjectNotFoundError when the source versionId is unknown', async () => {
      // Upload so the KEY exists — narrows the failure surface to "the
      // versionId is wrong" rather than "the key is missing entirely",
      // which is the exact shape the dev→VPS sync produces (key is
      // present on B2 with a fresh PUT version; DB carries the dev-side
      // MinIO UUID that B2 doesn't recognize).
      await storage.upload(testKey, Buffer.from('hello'), 'application/octet-stream');

      // A versionId that is structurally invalid for any provider. On
      // MinIO this is `NoSuchVersion` (404); on B2 this would be 400
      // InvalidArgument. Either way the HEAD probe catches the 4xx and
      // surfaces our typed not-found.
      await expect(
        storage.copyFromVersion(testKey, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('throws StorageObjectNotFoundError when the key does not exist at all', async () => {
      // Different from the previous test: this exercises the
      // key-itself-missing path (HEAD returns 404 because no version of
      // the key exists). Same 4xx classification → same outcome.
      await expect(
        storage.copyFromVersion(
          `test/never-uploaded-${Date.now()}.bin`,
          '00000000-0000-0000-0000-000000000000',
        ),
      ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('promotes a noncurrent version back to current when the source versionId is valid', async () => {
      // Round-trip: upload, capture the versionId via HEAD, hide
      // (creates a delete marker — current version is now the marker;
      // the original PUT becomes noncurrent), then copyFromVersion to
      // promote the original back to current. Mirrors the Papierkorb
      // restore flow on a versioned bucket.
      const original = Buffer.from('restore-me');
      await storage.upload(testKey, original, 'application/octet-stream');
      const head = await storage.headObject(testKey);
      expect(head.versionId).toBeDefined();
      const sourceVersionId = head.versionId!;

      await storage.hide(testKey);
      // Sanity: download must now fail because the current version is a
      // delete marker.
      await expect(storage.download(testKey)).rejects.toThrow();

      const newVersionId = await storage.copyFromVersion(testKey, sourceVersionId);
      expect(newVersionId).toBeDefined();

      // The promoted version is the new current; download succeeds and
      // returns the original bytes.
      const restored = await storage.download(testKey);
      expect(Buffer.from(restored.data).toString('utf-8')).toBe('restore-me');
    });
  });
});
