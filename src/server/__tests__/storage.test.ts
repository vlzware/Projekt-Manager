/**
 * API integration test: Object storage module.
 *
 * Test AT-16 from the test specification (verification.md §16.3).
 *
 * This tests the object storage module boundary directly (not through
 * HTTP routes). The module encapsulates upload/download/delete operations
 * against an S3-compatible object storage backend.
 *
 * Per architecture.md §11.4, the module must support:
 *   - Upload (key, data, content type) -> stored reference
 *   - Download (key) -> data stream
 *   - Delete (key) -> success/failure
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
import { createStorageClient } from '../../server/storage/client.js';
import type { StorageClient } from '../../server/storage/client.js';

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
  let storage: StorageClient;

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
        await storage.delete(testKey);
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

    it('deletes the uploaded file', async () => {
      // Own upload: delete needs something to delete. Setup, not ordering.
      await storage.upload(testKey, testContent, testContentType);

      await expect(storage.delete(testKey)).resolves.not.toThrow();
    });

    it('download after delete returns not-found or throws', async () => {
      // Full setup: upload then delete, so the assertion under test is
      // purely "download of a missing key fails". No reliance on any
      // other test having run first.
      await storage.upload(testKey, testContent, testContentType);
      await storage.delete(testKey);

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
});
