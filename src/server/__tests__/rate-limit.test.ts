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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../app.js';
import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import { SEED_USERS } from '../../test/seedAssumptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

let app: FastifyInstance;
let pool: pg.Pool;

describe('Login rate limiting (end-to-end)', () => {
  beforeAll(async () => {
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
  });

  // The production limit is `{ max: 5, timeWindow: '1 minute' }` per IP for
  // POST /api/auth/login — see `RATE_LIMIT.login` in src/server/config/index.ts.
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
});
