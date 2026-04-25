/**
 * CSP header pin — the directives the attachment upload flow depends
 * on are easy to lose in a CSP refactor and every loss is silent (the
 * browser blocks the request and the server never sees it). These tests
 * assert the presence of those directives so a regression fails CI
 * instead of shipping to the VPS and manifesting as "uploads stuck
 * pending".
 *
 * Scope: boots `buildApp` without a DB and inspects the response header
 * on any served path. No network / storage / CF activity.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { validateEnv } from '../config/env.js';

describe('CSP for attachment upload pipeline', () => {
  let app: FastifyInstance;
  const prevPublicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;
  const prevEndpoint = process.env.STORAGE_ENDPOINT;

  beforeEach(() => {
    // Force a fresh env read — validateEnv() caches the first parse, so
    // process.env edits between tests would be invisible without a cache
    // bust. The module-level cache lives in env.ts and is not exported,
    // so the only way to prime is via process.env before the first call.
    process.env.STORAGE_PUBLIC_ENDPOINT = 'https://storage.example.com';
    process.env.STORAGE_ENDPOINT = 'http://storage:9000';
    // Clear the env cache by re-importing via dynamic import in each
    // test block would be heavy-handed; instead we accept that the
    // first `validateEnv()` call pins the values and require tests in
    // this file to share that pin. If a test needs a different value,
    // split into its own describe with its own env setup.
    validateEnv();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (prevPublicEndpoint === undefined) delete process.env.STORAGE_PUBLIC_ENDPOINT;
    else process.env.STORAGE_PUBLIC_ENDPOINT = prevPublicEndpoint;
    if (prevEndpoint === undefined) delete process.env.STORAGE_ENDPOINT;
    else process.env.STORAGE_ENDPOINT = prevEndpoint;
  });

  async function getCsp(): Promise<string> {
    app = buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    const header = res.headers['content-security-policy'];
    expect(header).toBeTruthy();
    return String(header);
  }

  it('connect-src includes the public storage origin so presigned POST uploads are not CSP-blocked', async () => {
    const csp = await getCsp();
    expect(csp).toMatch(/connect-src[^;]*'self'[^;]*https:\/\/storage\.example\.com/);
  });

  it('img-src includes the public storage origin so presigned-GET thumbnails render', async () => {
    const csp = await getCsp();
    expect(csp).toMatch(/img-src[^;]*'self'[^;]*https:\/\/storage\.example\.com/);
  });

  it('img-src permits data: so @uploadcare/image-shrink EXIF probe + Eruda icons render', async () => {
    // The library loads a base64 JPEG into a hidden <img> to feature-detect
    // browser EXIF orientation handling on every shrinkFile() call. Without
    // data: the probe Promise hangs and uploads stall. Eruda's UI icons are
    // also data: URIs — same fix unblocks the mobile debug console.
    const csp = await getCsp();
    expect(csp).toMatch(/img-src[^;]*data:/);
  });

  it('worker-src is locked to self — only same-origin scripts can register workers', async () => {
    // The PWA service worker is registered from `/sw.js` (same-origin).
    // No code path spawns blob: workers; CSP stays tight.
    const csp = await getCsp();
    expect(csp).toMatch(/worker-src 'self'(?:;|$)/);
    expect(csp).not.toMatch(/worker-src[^;]*blob:/);
  });

  it('default-src stays locked to self', async () => {
    const csp = await getCsp();
    expect(csp).toMatch(/default-src 'self'/);
  });

  it('object-src permits self + blob: so Chrome PDF viewer embed renders', async () => {
    // Chrome's built-in PDF viewer uses an internal <embed> element to
    // paint the PDF. `object-src 'none'` blocks that and surfaces the
    // "This content is blocked" message. Allowing 'self' + blob: unblocks
    // the preview without opening the door to third-party embeds.
    const csp = await getCsp();
    expect(csp).toMatch(/object-src[^;]*'self'[^;]*blob:/);
  });

  it('frame-src permits self + blob: so same-origin PDF blob iframes load', async () => {
    // The PDF preview creates a same-origin blob: URL from the fetched
    // bytes and renders it in an <iframe>. Without this directive the
    // iframe falls back to `default-src 'self'`, which forbids the blob:
    // scheme and the preview modal renders blank.
    const csp = await getCsp();
    expect(csp).toMatch(/frame-src[^;]*'self'[^;]*blob:/);
  });

  it('frame-ancestors stays none', async () => {
    const csp = await getCsp();
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });
});
