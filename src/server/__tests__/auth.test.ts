/**
 * API integration tests: Authentication & session management.
 *
 * Tests AT-1 through AT-7 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * Seed users (from data-model.md §7.2) — referenced via SEED_USERS to
 * keep the coupling to `src/server/seed.ts` single-sourced:
 *   - owner (SEED_USERS.owner) — active, owner (admin)
 *   - office (SEED_USERS.office) — active, office
 *   - inactive (SEED_USERS.inactive) — active=false, for AT-3 / AT-7
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startApp,
  stopApp,
  getApp,
  login,
  authGet,
  authPost,
  createExpiredSession,
  deactivateUser,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Authentication & Session Management', () => {
  beforeAll(async () => {
    await startApp();
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-1: Login with valid credentials returns a session and user profile
  // ---------------------------------------------------------------
  describe('AT-1: Login with valid credentials', () => {
    it('returns 200 with session cookie and user profile', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(200);

      // Session token is in the HttpOnly cookie, not the response body
      const setCookie = res.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toBeDefined();
      expect(cookieStr).toMatch(/session=[^;]+/);
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Strict');

      const body = res.json();
      // Token must NOT appear in the response body
      expect(body).not.toHaveProperty('token');

      // User profile fields
      expect(body.user).toBeDefined();
      expect(body.user.id).toBeDefined();
      expect(body.user.username).toBe(SEED_USERS.owner.username);
      expect(body.user.displayName).toBe(SEED_USERS.owner.displayName);
      expect(body.user.roles).toEqual(expect.arrayContaining([...SEED_USERS.owner.roles]));
      expect(Array.isArray(body.user.roles)).toBe(true);

      // email may be undefined but the field should exist if set
      expect(body.user).toHaveProperty('email');
    });

    it('never includes passwordHash in the response', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: SEED_DEFAULT_PASSWORD },
      });

      const body = res.json();
      expect(body.user).not.toHaveProperty('passwordHash');
    });

    it('works for a different valid user (office)', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.office.username, password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(200);

      // Session cookie is set
      const setCookie = res.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toMatch(/session=[^;]+/);

      const body = res.json();
      expect(body).not.toHaveProperty('token');
      expect(body.user.username).toBe(SEED_USERS.office.username);
      expect(body.user.displayName).toBe(SEED_USERS.office.displayName);
      expect(body.user.roles).toEqual(expect.arrayContaining([...SEED_USERS.office.roles]));
    });
  });

  // ---------------------------------------------------------------
  // AT-2: Login with invalid credentials returns a generic error
  // ---------------------------------------------------------------
  describe('AT-2: Login with invalid credentials', () => {
    it('returns 401 with INVALID_CREDENTIALS for wrong password', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: 'wrongpassword' },
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('returns 401 with INVALID_CREDENTIALS for nonexistent user', async () => {
      // 'nobody' is intentionally NOT in SEED_USERS — the test proves a
      // username with no matching row fails. Keep the literal here.
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('returns identical error shape for wrong user and wrong password (no information leakage)', async () => {
      const wrongPassword = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: 'wrong' },
      });
      const wrongUser = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        // 'nonexistent' is intentionally not a seeded username.
        payload: { username: 'nonexistent', password: SEED_DEFAULT_PASSWORD },
      });

      expect(wrongPassword.statusCode).toBe(wrongUser.statusCode);

      const bodyA = wrongPassword.json();
      const bodyB = wrongUser.json();
      expect(bodyA.code).toBe(bodyB.code);
      // No information leakage: both must return the exact same message
      // so an attacker cannot distinguish "user not found" from "wrong password"
      expect(typeof bodyA.message).toBe('string');
      expect(bodyA.message.length).toBeGreaterThan(0);
      expect(bodyA.message).toBe(bodyB.message);
    });
  });

  // ---------------------------------------------------------------
  // AT-3: Login with an inactive user account returns a generic error
  // ---------------------------------------------------------------
  describe('AT-3: Login with inactive user', () => {
    it('returns 401 with INVALID_CREDENTIALS (same as wrong password)', async () => {
      // Seed includes an inactive user for this test — see SEED_USERS.inactive.
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.inactive.username, password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(typeof body.message).toBe('string');
    });

    it('is indistinguishable from a wrong-password error', async () => {
      const inactive = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.inactive.username, password: SEED_DEFAULT_PASSWORD },
      });
      const wrongPassword = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: 'wrong' },
      });

      expect(inactive.statusCode).toBe(wrongPassword.statusCode);

      const bodyInactive = inactive.json();
      const bodyWrong = wrongPassword.json();
      expect(bodyInactive.code).toBe(bodyWrong.code);
      // Same message — no information leakage between inactive and wrong password
      expect(typeof bodyInactive.message).toBe('string');
      expect(bodyInactive.message.length).toBeGreaterThan(0);
      expect(bodyInactive.message).toBe(bodyWrong.message);
    });
  });

  // ---------------------------------------------------------------
  // AT-4: An authenticated request with a valid session succeeds
  // ---------------------------------------------------------------
  describe('AT-4: Authenticated request with valid session', () => {
    it('GET /api/auth/me returns 200 with user profile', async () => {
      const token = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

      const res = await authGet(token, '/api/auth/me');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.username).toBe(SEED_USERS.owner.username);
      expect(body.displayName).toBe(SEED_USERS.owner.displayName);
      expect(body.roles).toEqual(expect.arrayContaining([...SEED_USERS.owner.roles]));
      expect(body).not.toHaveProperty('passwordHash');
    });
  });

  // ---------------------------------------------------------------
  // AT-5: A request with an expired session returns an authentication error
  // ---------------------------------------------------------------
  describe('AT-5: Expired session', () => {
    it('returns 401 with SESSION_EXPIRED', async () => {
      // 1. Log in to get a real user ID
      const setupToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      const meRes = await authGet(setupToken, '/api/auth/me');
      const userId = meRes.json().id;

      // 2. Create a real expired session in the database
      const expiredToken = await createExpiredSession(userId);

      // 3. Use the expired token — auth middleware must reject it
      const res = await authGet(expiredToken, '/api/auth/me');

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('SESSION_EXPIRED');
      expect(typeof body.message).toBe('string');
    });
  });

  // ---------------------------------------------------------------
  // AT-6: A request with no session returns an authentication error
  // ---------------------------------------------------------------
  describe('AT-6: Request with no session', () => {
    it('GET /api/auth/me without session cookie returns 401', async () => {
      const res = await getApp().inject({
        method: 'GET',
        url: '/api/auth/me',
        // No cookie header
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      // A missing session is NOT the same as an expired session.
      // SESSION_EXPIRED implies a session existed and timed out (client shows
      // "Sitzung abgelaufen" message). UNAUTHENTICATED means no session was
      // ever provided — the client shows a plain login screen.
      expect(body.code).toBe('UNAUTHENTICATED');
      expect(typeof body.message).toBe('string');
    });

    it('GET /api/projects without session cookie returns 401', async () => {
      const res = await getApp().inject({
        method: 'GET',
        url: '/api/projects',
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('UNAUTHENTICATED');
    });
  });

  // ---------------------------------------------------------------
  // AT-7: A request with a valid session token for a deactivated user
  //        returns an authentication error
  // ---------------------------------------------------------------
  describe('AT-7: Valid session for deactivated user', () => {
    it('returns 401 when the user has been deactivated after login', async () => {
      // 1. Log in as an active user — get a valid session token
      const validToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);

      // Confirm the session works before deactivation
      const beforeRes = await authGet(validToken, '/api/auth/me');
      expect(beforeRes.statusCode).toBe(200);
      const userId = beforeRes.json().id;

      // 2. Deactivate the user account in the database
      await deactivateUser(userId);

      // 3. Use the same token — auth middleware must reject it
      //    because session validation checks user.active (data-model.md §5.4)
      const res = await authGet(validToken, '/api/auth/me');

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('SESSION_EXPIRED');
      expect(typeof body.message).toBe('string');
    });
  });

  // ---------------------------------------------------------------
  // Logout: Session invalidation
  // Covers api.md §14.2.1: "Invalidates the specific session."
  // ---------------------------------------------------------------
  describe('Logout: Session invalidation', () => {
    it('invalidates the session so the token no longer works', async () => {
      // 1. Login — get a fresh token
      const logoutToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

      // 2. Verify the token works before logout
      const beforeRes = await authGet(logoutToken, '/api/auth/me');
      expect(beforeRes.statusCode).toBe(200);

      // 3. Logout — invalidate the session
      const logoutRes = await authPost(logoutToken, '/api/auth/logout');
      expect(logoutRes.statusCode).toBe(200);

      // 4. The same token must no longer work
      const afterRes = await authGet(logoutToken, '/api/auth/me');
      expect(afterRes.statusCode).toBe(401);

      // The error code must be SESSION_EXPIRED, not UNAUTHENTICATED.
      // Why it matters: this test passes the original token cookie back via
      // authGet, so the auth middleware sees a cookie and looks up the session
      // row. SESSION_EXPIRED is only returned when the row is MISSING from the
      // database (src/server/middleware/auth.ts:42-46) — so asserting this
      // code proves the logout actually deleted the session row, not just
      // cleared the browser cookie. Without this check, a silent regression
      // where logout only expired the cookie (leaving the row harvestable)
      // would pass the 401 assertion above.
      // See src/server/services/AuthService.ts:73 — the deleteSession call.
      const body = afterRes.json();
      expect(body.code).toBe('SESSION_EXPIRED');
    });
  });
});
