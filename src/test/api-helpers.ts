/**
 * API integration test helpers.
 *
 * Provides a shared Fastify app instance and convenience functions
 * for authenticated requests. Uses Fastify's `inject()` method
 * (in-process HTTP simulation, no actual network).
 */

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';

let app: FastifyInstance;

/**
 * Start the test application. Call in `beforeAll`.
 *
 * The app is shared across all tests in the suite to avoid
 * repeated startup cost. Each test is isolated through database
 * transactions (see TODO below).
 */
export async function startApp(): Promise<FastifyInstance> {
  // TODO: test database setup
  //   - Connect to a dedicated test database (not the dev/prod database)
  //   - Run migrations to ensure schema is current
  //   - Seed test data (users + projects)

  app = buildApp({ logger: false });
  await app.ready();
  return app;
}

/**
 * Shut down the test application. Call in `afterAll`.
 */
export async function stopApp(): Promise<void> {
  // TODO: test database teardown
  //   - Drop test data or roll back transaction
  //   - Close database connection pool

  if (app) {
    await app.close();
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
 * Convenience wrapper around POST /api/auth/login for tests
 * that need an authenticated session but are not testing login itself.
 */
export async function login(
  username: string,
  password: string,
): Promise<string> {
  const res = await getApp().inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });

  if (res.statusCode !== 200) {
    throw new Error(
      `Login failed for "${username}": ${res.statusCode} ${res.body}`,
    );
  }

  const body = res.json<{ token: string }>();
  return body.token;
}

/**
 * Make an authenticated GET request.
 */
export async function authGet(token: string, url: string) {
  return getApp().inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Make an authenticated POST request.
 */
export async function authPost(
  token: string,
  url: string,
  payload?: Record<string, unknown>,
) {
  return getApp().inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

/**
 * Make an authenticated PATCH request.
 */
export async function authPatch(
  token: string,
  url: string,
  payload?: Record<string, unknown>,
) {
  return getApp().inject({
    method: 'PATCH',
    url,
    headers: { authorization: `Bearer ${token}` },
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
 * TODO: implement once the session table and database test setup exist.
 */
export async function createExpiredSession(
  _userId: string,
): Promise<string> {
  throw new Error('not implemented');
}

/**
 * Deactivate a user account by setting active=false in the database.
 *
 * Used by AT-7 to simulate the "logged-in user gets deactivated" flow:
 * login normally, deactivate the account, then assert the existing token
 * is rejected on the next request.
 *
 * TODO: implement once the user table and database test setup exist.
 */
export async function deactivateUser(_userId: string): Promise<void> {
  throw new Error('not implemented');
}
