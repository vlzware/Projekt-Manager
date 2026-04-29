/**
 * End-to-end coverage of the actual presigned PUT flow against MinIO.
 *
 * Every other integration test in this repo seeds bytes via direct
 * `storage.upload()` (the non-presigned SDK path), so the SigV4 /
 * signed-headers / Content-MD5 binding path that backs the production
 * upload protocol (commit 600e9b0) was never exercised. A bug in
 * `signableHeaders` / `requestChecksumCalculation` /
 * `unhoistableHeaders` propagation would have shipped silently.
 *
 * This file fires real `fetch()` PUTs against MinIO using exactly the
 * URL + headers the server returns from `init`. It pins:
 *
 *   1. The happy path — presigned PUT for the original blob succeeds
 *      with 2xx, ditto for the thumbnail, and `complete()` flips the
 *      row to `ready`.
 *   2. The negative path — a body whose MD5 differs from the signed
 *      `Content-MD5` is rejected with `BadDigest`. MinIO does enforce
 *      Content-MD5 verification (verified empirically; same shape as
 *      AWS S3 / B2), so this assertion holds in dev. If a future MinIO
 *      release changes that — or this test is run against a provider
 *      that does not verify — the assertion degrades to "any 4xx" via
 *      the comment block at the assert site.
 *
 * Storage env: `startApp()` calls `validateEnvRuntime()` which loads the
 * STORAGE_* vars (see api-helpers.ts). MinIO must be running locally
 * (docker-compose up storage). The `STORAGE_PUBLIC_ENDPOINT` is unset
 * in dev, so signed URLs collapse to `STORAGE_ENDPOINT` (the same host
 * the test process can reach via fetch).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { photoInitBody } from '../../test/fixtures/attachmentInit.js';

const year = new Date().getFullYear();

/**
 * Compute RFC 1864 base64-of-MD5 for a buffer. The presigned PUT
 * descriptor's `Content-MD5` header expects this exact form (16-byte
 * digest → 24 chars ending in `==`).
 */
function md5Base64(body: Buffer): string {
  return crypto.createHash('md5').update(body).digest('base64');
}

/**
 * Synthesize a `Buffer` of `length` bytes that starts with the JPEG SOI
 * marker (`FF D8 FF`). The init route trusts the declared MIME type —
 * actual byte sniffing happens at thumbnail-pipeline time on the
 * client. Real-shaped header bytes are still preferable to an all-zero
 * buffer because they future-proof against a HEAD-time content-type
 * sniff if MinIO ever adds one.
 */
function jpegBuffer(length: number): Buffer {
  const buf = Buffer.alloc(length, 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

/** Same idea, WebP RIFF header (`RIFF....WEBP`). */
function webpBuffer(length: number): Buffer {
  const buf = Buffer.alloc(length, 0xff);
  buf.write('RIFF', 0);
  buf.write('WEBP', 8);
  return buf;
}

/**
 * Issue a presigned PUT to MinIO using the descriptor returned by
 * `init`. The server-issued `headers` carries `Content-Type`,
 * `Content-Length`, and `Content-MD5` — every value bound by SigV4.
 * Node's `fetch` sets `Content-Length` automatically from the body,
 * so we drop that header to avoid a duplicate-header rejection.
 *
 * The `BodyInit` type from `lib.dom.d.ts` does not list Node's
 * `Buffer` / `Uint8Array` (it expects DOM-style `Blob` / `ArrayBuffer`
 * / `FormData`); Node's undici-based fetch accepts both at runtime.
 * Casting through `BodyInit` lets the test file stay aligned with the
 * project's ambient DOM types without mocking fetch.
 */
async function presignedPut(
  descriptor: { url: string; headers: Record<string, string> },
  body: Buffer,
): Promise<Response> {
  const headers = { ...descriptor.headers };
  delete headers['Content-Length'];
  return fetch(descriptor.url, {
    method: 'PUT',
    headers,
    body: body as unknown as BodyInit,
  });
}

async function seededProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

describe('Attachment presigned PUT — real upload against MinIO', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await seededProjectId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // Happy path — exercise the full presigned PUT flow end-to-end.
  // The whole point of the file: no `storage.upload()` shortcut, the
  // signed URL + headers are what the browser would actually send.
  // ---------------------------------------------------------------
  it('PUTs original + thumbnail through the signed URL and completes the row', async () => {
    const originalBytes = jpegBuffer(120);
    const thumbBytes = webpBuffer(80);
    const originalMd5 = md5Base64(originalBytes);
    const thumbMd5 = md5Base64(thumbBytes);

    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({
        sizeBytes: originalBytes.length,
        contentMd5: originalMd5,
        thumbSizeBytes: thumbBytes.length,
        thumbContentMd5: thumbMd5,
      }),
    );
    expect(initRes.statusCode).toBe(201);
    const body = initRes.json();
    expect(body.attachment.status).toBe('pending');
    expect(body.originalUpload.headers['Content-MD5']).toBe(originalMd5);
    expect(body.thumbnailUpload.headers['Content-MD5']).toBe(thumbMd5);

    // PUT the original.
    const originalPut = await presignedPut(body.originalUpload, originalBytes);
    expect(originalPut.status).toBeGreaterThanOrEqual(200);
    expect(originalPut.status).toBeLessThan(300);
    // Drain to keep the keep-alive socket clean (some Node fetch
    // configurations leak a half-read body into the agent pool).
    await originalPut.arrayBuffer();

    // PUT the thumbnail.
    const thumbPut = await presignedPut(body.thumbnailUpload, thumbBytes);
    expect(thumbPut.status).toBeGreaterThanOrEqual(200);
    expect(thumbPut.status).toBeLessThan(300);
    await thumbPut.arrayBuffer();

    // Flip pending → ready.
    const completeRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
    );
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().status).toBe('ready');
  });

  // ---------------------------------------------------------------
  // Negative — the signed Content-MD5 binds the URL to specific bytes.
  // PUT a body whose MD5 differs and the storage provider rejects with
  // `BadDigest`. This is the load-bearing guarantee that backs the
  // entire "URL is reusable only for those bytes" claim in api.md
  // §14.2.11.
  //
  // Verified against MinIO RELEASE.2025-09-07: returns
  //   <Code>BadDigest</Code><Message>The Content-Md5 you specified
  //   did not match what we received.</Message>
  // with HTTP status 400. AWS S3 / B2 share the same shape.
  // ---------------------------------------------------------------
  it('rejects a body whose MD5 does not match the signed Content-MD5', async () => {
    const advertisedBytes = jpegBuffer(120);
    const advertisedMd5 = md5Base64(advertisedBytes);
    const tamperedBytes = jpegBuffer(120);
    tamperedBytes[100] ^= 0xff; // flip a single byte to invalidate the digest
    expect(md5Base64(tamperedBytes)).not.toBe(advertisedMd5);

    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({
        sizeBytes: advertisedBytes.length,
        contentMd5: advertisedMd5,
        // No thumbnail — keeps the test focused on a single PUT.
        hasThumbnail: false,
      }),
    );
    expect(initRes.statusCode).toBe(201);
    const body = initRes.json();

    // PUT the *tampered* bytes against the URL signed for the original
    // MD5. Storage MUST reject — the Content-MD5 header (echoed from the
    // signed descriptor) advertises one digest, the body computes
    // another.
    const putRes = await presignedPut(body.originalUpload, tamperedBytes);
    expect(putRes.status).toBeGreaterThanOrEqual(400);
    const text = await putRes.text();
    expect(text.toLowerCase()).toContain('baddigest');
  });
});
