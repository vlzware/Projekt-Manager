/**
 * VAPID public-key endpoint tests — ADR-0023 / api.md §14.2.10.
 *
 * The endpoint is the runtime source of truth for the client's VAPID
 * public key, replacing the build-time `VITE_VAPID_PUBLIC_KEY` env.
 * These tests pin:
 *   - Configured case: `VAPID_PUBLIC_KEY` set → 200 with the key.
 *   - Absent case: any of the triple missing → 200 with `null`.
 *   - Method shape: non-GET verbs → 405, not 404 (an accidental POST
 *     deserves a pointed response so clients notice).
 *
 * Scope: unit-level. The endpoint does not touch the DB or the auth
 * middleware, so a minimal Fastify instance with the public plugin
 * registered is enough — no integration harness needed.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Env is module-cached; mocking `getEnv` is the cleanest way to
// control VAPID_* values across tests. The values shape the
// endpoint response directly (see routes/push.ts).
vi.mock('../config/env.js', () => ({
  getEnv: vi.fn(),
}));

import { getEnv } from '../config/env.js';
import { pushPublicRoutes } from '../routes/push.js';

const mockGetEnv = vi.mocked(getEnv);

/**
 * Minimal shape covering only the fields the route reads. Cast to the
 * full Env type at the mock boundary so the production call-site sees
 * the expected surface.
 */
function envWith(vapid: {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
}): ReturnType<typeof getEnv> {
  return {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: vapid.subject,
  } as ReturnType<typeof getEnv>;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(pushPublicRoutes());
  await app.ready();
  return app;
}

describe('GET /api/push/vapid-public-key', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the configured public key when the full VAPID triple is set', async () => {
    mockGetEnv.mockReturnValue(
      envWith({
        publicKey: 'BPublic_key_url_safe_base64',
        privateKey: 'private-key-server-only',
        subject: 'mailto:admin@example.test',
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vapidPublicKey: 'BPublic_key_url_safe_base64' });
    // Short cache: the client re-fetches on each subscribe attempt, so
    // an hour-long cache would mask a deploy-time key rotation.
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('returns null when VAPID_PUBLIC_KEY is absent', async () => {
    mockGetEnv.mockReturnValue(
      envWith({
        publicKey: undefined,
        privateKey: 'private',
        subject: 'mailto:admin@example.test',
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vapidPublicKey: null });
  });

  it('returns null when VAPID_PRIVATE_KEY is absent (half-configured is not configured)', async () => {
    // Public key present but private missing — server cannot dispatch,
    // so surfacing the public key would let the client subscribe to a
    // transport that silently drops every message.
    mockGetEnv.mockReturnValue(
      envWith({
        publicKey: 'BPublic_key',
        privateKey: undefined,
        subject: 'mailto:admin@example.test',
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vapidPublicKey: null });
  });

  it('returns null when VAPID_SUBJECT is absent', async () => {
    mockGetEnv.mockReturnValue(
      envWith({
        publicKey: 'BPublic_key',
        privateKey: 'private',
        subject: undefined,
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vapidPublicKey: null });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('rejects %s with 405', async (method) => {
    mockGetEnv.mockReturnValue(envWith({}));

    const res = await app.inject({ method, url: '/api/push/vapid-public-key' });

    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('GET');
  });
});
