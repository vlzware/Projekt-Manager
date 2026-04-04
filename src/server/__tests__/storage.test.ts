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

describe('Object Storage Module', () => {
  let storage: StorageClient;

  beforeAll(async () => {
    const endpoint = process.env.STORAGE_ENDPOINT;
    const bucket = process.env.STORAGE_BUCKET;
    const accessKey = process.env.STORAGE_ACCESS_KEY;
    const secretKey = process.env.STORAGE_SECRET_KEY;

    if (!endpoint || !bucket || !accessKey || !secretKey) {
      console.warn(
        'Skipping storage tests: STORAGE_ENDPOINT, STORAGE_BUCKET, ' +
          'STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY must be set.',
      );
      return;
    }

    storage = createStorageClient({
      endpoint,
      bucket,
      accessKey,
      secretKey,
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
      if (!storage) return; // skip if no credentials
      const result = await storage.upload(testKey, testContent, testContentType);
      expect(result).toBeDefined();
      expect(result.key).toBe(testKey);
    });

    it('retrieves the uploaded file with matching contents', async () => {
      if (!storage) return;
      const downloaded = await storage.download(testKey);
      expect(
        Buffer.isBuffer(downloaded.data) || downloaded.data instanceof Uint8Array,
      ).toBe(true);
      expect(Buffer.from(downloaded.data).toString('utf-8')).toBe(
        testContent.toString('utf-8'),
      );
      expect(downloaded.contentType).toBe(testContentType);
    });

    it('generates a signed URL for the uploaded file', async () => {
      if (!storage) return;
      const url = await storage.getSignedUrl(testKey, 60);
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^https?:\/\//);
    });

    it('deletes the uploaded file', async () => {
      if (!storage) return;
      await expect(storage.delete(testKey)).resolves.not.toThrow();
    });

    it('download after delete returns not-found or throws', async () => {
      if (!storage) return;
      await expect(storage.download(testKey)).rejects.toThrow();
    });
  });
});
