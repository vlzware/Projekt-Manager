/**
 * API integration test helpers.
 *
 * Provides a shared Fastify app instance and convenience functions
 * for authenticated requests. Uses Fastify's `inject()` method
 * (in-process HTTP simulation, no actual network).
 */

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { validateEnv } from '../server/config/env.js';
import { createDatabase } from '../server/db/connection.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../server/seed.js';
import { deactivateUser as deactivateUserRepo } from '../server/repositories/user.js';
import { randomBytes } from 'node:crypto';
import type { Database } from '../server/db/connection.js';
import { sessions, users } from '../server/db/schema.js';
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
  // Validate the env once at startup — consolidation review C-3 removed
  // the dual ALLOW_INSECURE_HTTP code paths, so getEnv() is now the single
  // source of truth. Integration tests need validateEnv() called before
  // buildApp() accesses getEnv().
  validateEnv();

  const conn = createDatabase();
  db = conn.db;
  pool = conn.pool;

  // Verify the new pool is live and PG has released prior connections
  await pool.query('SELECT 1');

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
 *
 * Closing order matters: Fastify first (stops accepting requests and
 * waits for in-flight handlers to finish), then drain the pg pool.
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
 * is rejected on the next request. Tests pass actorId=null because no
 * human admin exists in this iteration — the audit pattern allows
 * updatedBy to be null for system/test-fixture actions (data-model.md §5.5).
 */
export async function deactivateUser(userId: string): Promise<void> {
  return deactivateUserRepo(db, userId, null);
}

/**
 * Create an authenticated test user with the given roles and return a
 * ready-to-use session token. The password hash is a placeholder — this
 * helper mints the session directly in the database, bypassing login.
 *
 * Used by permission tests to construct users that do not match any seed
 * role (e.g. roles: [] for a user with no permissions at all). Regular
 * tests should log in via seed users instead.
 */
export async function createTestUserSession(options: {
  roles: string[];
  displayName?: string;
}): Promise<{ userId: string; token: string }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour ahead
  const username = `test_${randomBytes(6).toString('hex')}`;
  const userRows = await db
    .insert(users)
    .values({
      username,
      displayName: options.displayName ?? 'Test User',
      // Placeholder hash — this helper bypasses login, so the value is
      // never verified. Non-empty because the column is NOT NULL.
      passwordHash: 'test-no-password-verification',
      roles: options.roles,
      active: true,
    })
    .returning();
  const userId = userRows[0]!.id;
  await db.insert(sessions).values({ userId, token, expiresAt });
  return { userId, token };
}
