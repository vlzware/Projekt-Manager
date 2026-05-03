/**
 * AC-247 / AT-108 — Global error handler 4xx pass-through.
 *
 * Verifies that the API server's `setErrorHandler` and `setNotFoundHandler`
 * honor the HTTP statusCode native to a 4xx-class failure rather than
 * collapsing it to 500 SERVER_ERROR. Existing branches (schema-validation
 * 422, 5xx fallback) are exercised here as regression guards. The
 * rate-limit 429 branch is already covered end-to-end in
 * `rate-limit.test.ts` and is not duplicated here (T-REDU).
 *
 * The test builds a routeless app via `buildApp({ db: undefined })` so the
 * global error / not-found handlers are installed without the production
 * routes running, then attaches per-test routes that drive each handler
 * branch. Logger calls are captured to verify the operational `error`
 * level reflects only genuine 5xx failures.
 *
 * Pins AC-247 (verification.md §15.7) and the principle in api.md §14.4.2.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

const TINY_BODY_LIMIT = 100;

const SCHEMA_X_INTEGER = {
  body: {
    type: 'object',
    required: ['x'],
    properties: { x: { type: 'integer' } },
    additionalProperties: false,
  },
} as const;

let app: FastifyInstance;
let errorSpy: ReturnType<typeof vi.spyOn>;

describe('AC-247 / AT-108 — Global error handler 4xx pass-through', () => {
  beforeAll(async () => {
    app = buildApp({ logger: false, rateLimit: false });
    errorSpy = vi.spyOn(app.log, 'error');

    // /test/echo — no body schema, so empty-JSON-body and unsupported
    // media-type cases are decided by the content-type parser, not ajv.
    app.post('/test/echo', async (req, reply) => reply.send({ received: req.body }));

    // /test/tiny — per-route bodyLimit so the oversize case is cheap to trigger.
    app.post('/test/tiny', { bodyLimit: TINY_BODY_LIMIT }, async (req, reply) =>
      reply.send({ received: req.body }),
    );

    // /test/schema — body schema for the regression-guard 422 branch.
    app.post('/test/schema', { schema: SCHEMA_X_INTEGER }, async (_req, reply) =>
      reply.send({ ok: true }),
    );

    // /test/throw-503 — synthetic 5xx error from inside a handler.
    app.post('/test/throw-503', async () => {
      const err = new Error('synthetic upstream') as Error & { statusCode: number };
      err.statusCode = 503;
      throw err;
    });

    // /test/throw-no-status — synthetic error with no statusCode at all.
    // Assumes Fastify leaves `statusCode` undefined on a plain `throw new Error()`
    // when delegating to `setErrorHandler`. If a future Fastify auto-attaches
    // a 500 here, this case collapses into the throw-503 case — adjust by
    // asserting on `statusCode === undefined` inside the handler under test.
    app.post('/test/throw-no-status', async () => {
      throw new Error('synthetic without statusCode');
    });

    await app.ready();
  });

  afterAll(async () => {
    errorSpy?.mockRestore();
    if (app) await app.close();
  });

  // ---------------- Transport-layer 4xx: the new contract ----------------

  it('empty JSON body → 400 VALIDATION_ERROR (not 500)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('payload exceeding the configured limit → 413 VALIDATION_ERROR (not 500)', async () => {
    errorSpy.mockClear();
    const oversized = JSON.stringify({ x: 'a'.repeat(TINY_BODY_LIMIT * 2) });
    const res = await app.inject({
      method: 'POST',
      url: '/test/tiny',
      headers: { 'content-type': 'application/json' },
      payload: oversized,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('unsupported Content-Type → 415 VALIDATION_ERROR (not 500)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<x>1</x>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('unknown URL → 404 ROUTE_NOT_FOUND (not the default Fastify shape)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'GET',
      url: '/api/this-route-does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ROUTE_NOT_FOUND');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // ---------------- Existing branches: regression guards ----------------

  it('schema-validation rejection still → 422 VALIDATION_ERROR with details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/schema',
      payload: { x: 'not-an-integer' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });

  // ---------------- 5xx fallback: regression guards ----------------

  it('synthetic 5xx error (statusCode 503) → 500 SERVER_ERROR (logged at error)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/test/throw-503',
      payload: { ok: true },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('SERVER_ERROR');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('error without statusCode → 500 SERVER_ERROR (logged at error)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/test/throw-no-status',
      payload: { ok: true },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('SERVER_ERROR');
    expect(errorSpy).toHaveBeenCalled();
  });
});
