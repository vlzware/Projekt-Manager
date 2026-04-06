/**
 * API integration test helpers.
 *
 * Provides a shared Fastify app instance and convenience functions
 * for authenticated requests. Uses Fastify's `inject()` method
 * (in-process HTTP simulation, no actual network).
 */

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { createDatabase } from '../server/db/connection.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../server/seed.js';
import { deactivateUser as deactivateUserRepo } from '../server/repositories/user.js';
import { randomBytes } from 'node:crypto';
import type { Database } from '../server/db/connection.js';
import { sessions } from '../server/db/schema.js';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

let app: FastifyInstance;
let db: Database;
let pool: pg.Pool;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../server/db/migrations');

/**
 * Start the test application. Call in `beforeAll`.
 *
 * Connects to the test database, runs migrations, seeds data,
 * and boots a Fastify instance. Test files run sequentially
 * (fileParallelism: false in vitest.config.ts integration project) so each file
 * gets a fresh seed without race conditions.
 */
export async function startApp(): Promise<FastifyInstance> {
  const conn = createDatabase();
  db = conn.db;
  pool = conn.pool;

  // Run migrations (idempotent — drizzle tracks applied migrations)
  await migrate(db, { migrationsFolder });

  // Seed fresh test data (force: wipe and re-seed for clean slate)
  await seed(db, { force: true });

  app = buildApp({ logger: false, db, rateLimit: false });
  await app.ready();
  return app;
}

/**
 * Shut down the test application. Call in `afterAll`.
 */
export async function stopApp(): Promise<void> {
  if (app) {
    await app.close();
  }
  if (pool) {
    await pool.end();
  }
}

/**
 * Get the current app instance.
 * Throws if `startApp()` has not been called.
 */
export function getApp(): FastifyInstance {
  if (!app) {
    throw new Error('Test app not started. Call startApp() in beforeAll.');
  }
  return app;
}

/**
 * Log in as a user and return the session token.
 *
 * Extracts the token from the `set-cookie` header (HttpOnly session
 * cookie). Tests pass this token back via `cookie: 'session=<token>'`
 * in subsequent requests.
 */
export async function login(username: string, password: string): Promise<string> {
  const res = await getApp().inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });

  if (res.statusCode !== 200) {
    throw new Error(`Login failed for "${username}": ${res.statusCode} ${res.body}`);
  }

  const setCookie = res.headers['set-cookie'];
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = cookieStr?.match(/session=([^;]+)/);
  if (!match) {
    throw new Error(`Login for "${username}" did not return a session cookie`);
  }
  return match[1];
}

/**
 * Make an authenticated GET request.
 */
export async function authGet(token: string, url: string) {
  return getApp().inject({
    method: 'GET',
    url,
    headers: { cookie: `session=${token}` },
  });
}

/**
 * Make an authenticated POST request.
 */
export async function authPost(token: string, url: string, payload?: Record<string, unknown>) {
  return getApp().inject({
    method: 'POST',
    url,
    headers: { cookie: `session=${token}` },
    payload,
  });
}

/**
 * Make an authenticated PATCH request.
 */
export async function authPatch(token: string, url: string, payload?: Record<string, unknown>) {
  return getApp().inject({
    method: 'PATCH',
    url,
    headers: { cookie: `session=${token}` },
    payload,
  });
}

/**
 * Create an expired session for the given user and return its token.
 *
 * The session must be a real database row whose expiresAt is in the past.
 * This lets AT-5 verify that the auth middleware rejects expired sessions
 * with the correct error code — something a fabricated string can never do.
 *
 * Test-only helper — intentionally NOT in production code.
 */
export async function createExpiredSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiredAt = new Date(Date.now() - 60_000); // 1 minute in the past
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      token,
      expiresAt: expiredAt,
    })
    .returning();
  return rows[0]!.token;
}

/**
 * Deactivate a user account by setting active=false in the database.
 *
 * Used by AT-7 to simulate the "logged-in user gets deactivated" flow:
 * login normally, deactivate the account, then assert the existing token
 * is rejected on the next request.
 */
export async function deactivateUser(userId: string): Promise<void> {
  return deactivateUserRepo(db, userId);
}
