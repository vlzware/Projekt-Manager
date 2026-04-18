/**
 * API integration test: Login rate limiting end-to-end.
 *
 * The shared test helper in `src/test/api-helpers.ts` builds the Fastify app
 * with `rateLimit: false` so the other integration tests can hammer the API
 * without tripping the 5-per-minute login limit. That leaves rate limiting
 * itself un-exercised — this file closes that gap by building its own
 * dedicated app instance with rate limiting **enabled** and asserting that
 * the 6th login attempt from the same IP inside the window returns 429.
 *
 * Notes on isolation:
 *   - `@fastify/rate-limit` defaults to an in-memory LRU store scoped to the
 *     plugin instance, so the limiter state lives for exactly as long as this
 *     test's `app` does and does not leak into other files.
 *   - We pass `remoteAddress` explicitly so the limiter key is deterministic
 *     regardless of whatever address fastify's inject default picks.
 *   - We do NOT reuse `startApp()` because it hard-codes `rateLimit: false`
 *     (that's the whole reason this file exists).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../app.js';
import { validateEnv } from '../config/env.js';
import { getRateLimit } from '../config/index.js';
import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import { SEED_USERS } from '../../test/seedAssumptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

let app: FastifyInstance;
let pool: pg.Pool;

describe('Login rate limiting (end-to-end)', () => {
  // Vitest runs with NODE_ENV=test, where `getRateLimit()` defaults the
  // login ceiling to 30/min so E2E flows with many fresh contexts don't
  // throttle. Pin the production ceiling (5/min) explicitly here — this
  // test is the one that verifies the *production* behaviour.
  const originalLimit = process.env.LOGIN_RATE_LIMIT_MAX;

  beforeAll(async () => {
    process.env.LOGIN_RATE_LIMIT_MAX = '5';

    // buildApp() reads the validated env (see config/index.ts and app.ts) —
    // any test that bypasses startApp() must call validateEnv() itself.
    validateEnv();

    const conn = createDatabase();
    pool = conn.pool;

    // Verify the pool is live before we touch it.
    await pool.query('SELECT 1');

    // Run migrations (idempotent — drizzle tracks applied migrations) and
    // seed fresh test data so `SEED_USERS.owner` exists for the login call.
    await migrate(conn.db, { migrationsFolder });
    await seed(conn.db, { force: true });

    // Rate limiting ENABLED — this is the whole point of the file.
    app = buildApp({ logger: false, db: conn.db, rateLimit: true });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (originalLimit === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
    else process.env.LOGIN_RATE_LIMIT_MAX = originalLimit;
  });

  // The production limit is `{ max: 5, timeWindow: '1 minute' }` per IP for
  // POST /api/auth/login — see `getRateLimit().login` in src/server/config/index.ts.
  // Using wrong credentials so we don't burn a valid session + deliberately
  // get 401s on the first 5 attempts; the 6th must be rejected by the limiter
  // BEFORE the credentials check runs, so it becomes 429.
  it('returns 429 on the 6th login attempt within the 1-minute window', async () => {
    const payload = { username: SEED_USERS.owner.username, password: 'wrongpassword' };
    const remoteAddress = '10.0.0.1';

    // First 5 attempts should NOT be rate-limited. Wrong password yields 401,
    // but importantly none of them are 429. (If somehow one succeeded with a
    // 200 that would also be fine — the assertion is strictly "not 429".)
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload,
        remoteAddress,
      });
      statuses.push(res.statusCode);
    }

    expect(statuses.every((s) => s !== 429)).toBe(true);

    // 6th attempt inside the same 1-minute window must be rate-limited.
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload,
      remoteAddress,
    });
    expect(sixth.statusCode).toBe(429);

    // The response body must be the RATE_LIMITED AppError shape — without
    // the error-handler translation in src/server/app.ts the plugin's
    // vanilla Error would fall through to 500 SERVER_ERROR. Asserting the
    // code and a non-empty message guards that translation path.
    const body = sixth.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);

    // @fastify/rate-limit sets the Retry-After header before throwing.
    // Asserting it here proves our error handler's reply.code + send
    // preserves headers the plugin added (rather than wiping them with a
    // fresh 500 response).
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  // The change-password limit is `{ max: 5, timeWindow: '1 minute' }` per IP,
  // declared the same way as the login limit (see getRateLimit().passwordChange in
  // src/server/config/index.ts). Before this test the limit was wired but
  // unverified — a regression that dropped the config from the route would
  // slip through login-only coverage. We use a distinct remoteAddress so the
  // login-test limiter key and this test's limiter key don't collide.
  it('returns 429 on the 6th change-password attempt within the 1-minute window', async () => {
    // Log in first so we have a session cookie — change-password requires
    // authentication, and we want the rate limiter to fire BEFORE the
    // business-logic check rejects the wrong current password.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: SEED_USERS.owner.username, password: 'changeme' },
      remoteAddress: '10.0.0.2',
    });
    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    const match = cookieStr.match(/session=([^;]+)/);
    expect(match).not.toBeNull();
    const token = match![1]!;

    const payload = { currentPassword: 'wrong', newPassword: 'alsowrong1234567' };
    const remoteAddress = '10.0.0.2';

    // First 5 attempts should hit the business-logic path (401 invalid
    // credentials) but NOT 429.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: `session=${token}` },
        payload,
        remoteAddress,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.every((s) => s !== 429)).toBe(true);

    // 6th attempt inside the same 1-minute window must be 429.
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: `session=${token}` },
      payload,
      remoteAddress,
    });
    expect(sixth.statusCode).toBe(429);

    const body = sixth.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(sixth.headers['retry-after']).toBeDefined();
  });
});

// Unit-level pins on getRateLimit()'s environment-aware default. The
// integration block above proves the 5/min ceiling actually rejects the
// 6th request; these cases pin the selection logic between production
// (5/min) and dev/test (30/min) so a regression that swaps the branches
// is caught without spinning up the app.
describe('getRateLimit() login default selection', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.LOGIN_RATE_LIMIT_MAX;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalOverride === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
    else process.env.LOGIN_RATE_LIMIT_MAX = originalOverride;
  });

  it('production with no override → 5/min', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    expect(getRateLimit().login.max).toBe(5);
  });

  it('missing NODE_ENV is treated as production → 5/min (fail-closed)', () => {
    delete process.env.NODE_ENV;
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    expect(getRateLimit().login.max).toBe(5);
  });

  it('development with no override → 30/min (E2E-friendly)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    expect(getRateLimit().login.max).toBe(30);
  });

  it('test with no override → 30/min (E2E-friendly)', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    expect(getRateLimit().login.max).toBe(30);
  });

  it('override wins over NODE_ENV default', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOGIN_RATE_LIMIT_MAX = '100';
    expect(getRateLimit().login.max).toBe(100);
  });

  it('invalid override (non-numeric) falls back to the NODE_ENV default', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOGIN_RATE_LIMIT_MAX = 'notanumber';
    expect(getRateLimit().login.max).toBe(30);
  });
});
