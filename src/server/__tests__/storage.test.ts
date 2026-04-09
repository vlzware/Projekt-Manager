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

import { describe, it, expect, beforeAll } from 'vitest';
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
  describe('AT-16: Upload, retrieve, and verify', () => {
    const testKey = `test/at-16-${Date.now()}.txt`;
    const testContent = Buffer.from(
      'AT-16 Testdatei: Projekt-Manager Objekt-Speicher Integrationstest.',
      'utf-8',
    );
    const testContentType = 'text/plain';

    it('uploads a file without error', async () => {
      const result = await storage.upload(testKey, testContent, testContentType);
      expect(result).toBeDefined();
      expect(result.key).toBe(testKey);
    });

    it('retrieves the uploaded file with matching contents', async () => {
      const downloaded = await storage.download(testKey);
      expect(Buffer.isBuffer(downloaded.data) || downloaded.data instanceof Uint8Array).toBe(true);
      expect(Buffer.from(downloaded.data).toString('utf-8')).toBe(testContent.toString('utf-8'));
      expect(downloaded.contentType).toBe(testContentType);
    });

    it('generates a signed URL for the uploaded file', async () => {
      const url = await storage.getSignedUrl(testKey, 60);
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^https?:\/\//);
    });

    it('deletes the uploaded file', async () => {
      await expect(storage.delete(testKey)).resolves.not.toThrow();
    });

    it('download after delete returns not-found or throws', async () => {
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
