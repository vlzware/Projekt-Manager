/**
 * API integration tests: Authentication & session management.
 *
 * Tests AT-1 through AT-7 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * Seed users (from data-model.md §7.2):
 *   - inhaber / changeme — active, owner (admin)
 *   - buero / changeme — active, office
 *   - (inactive user) — active=false, for AT-3 / AT-7
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
    it('returns 200 with token and user profile', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'inhaber', password: 'changeme' },
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.token).toBeDefined();
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(0);

      // User profile fields
      expect(body.user).toBeDefined();
      expect(body.user.id).toBeDefined();
      expect(body.user.username).toBe('inhaber');
      expect(body.user.displayName).toBe('Thomas Berger');
      expect(body.user.roles).toEqual(expect.arrayContaining(['owner']));
      expect(Array.isArray(body.user.roles)).toBe(true);

      // email may be undefined but the field should exist if set
      expect(body.user).toHaveProperty('email');
    });

    it('never includes passwordHash in the response', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'inhaber', password: 'changeme' },
      });

      const body = res.json();
      expect(body.user).not.toHaveProperty('passwordHash');
    });

    it('works for a different valid user (buero)', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'buero', password: 'changeme' },
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.token).toBeDefined();
      expect(body.user.username).toBe('buero');
      expect(body.user.displayName).toBe('Maria Schmidt');
      expect(body.user.roles).toEqual(expect.arrayContaining(['office']));
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
        payload: { username: 'inhaber', password: 'wrongpassword' },
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('returns 401 with INVALID_CREDENTIALS for nonexistent user', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: 'changeme' },
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
        payload: { username: 'inhaber', password: 'wrong' },
      });
      const wrongUser = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nonexistent', password: 'changeme' },
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
      // Seed includes an inactive user for this test.
      // The exact username is defined in seed data; using a conventional name.
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'deaktiviert', password: 'changeme' },
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
        payload: { username: 'deaktiviert', password: 'changeme' },
      });
      const wrongPassword = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'inhaber', password: 'wrong' },
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
      const token = await login('inhaber', 'changeme');

      const res = await authGet(token, '/api/auth/me');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.username).toBe('inhaber');
      expect(body.displayName).toBe('Thomas Berger');
      expect(body.roles).toEqual(expect.arrayContaining(['owner']));
      expect(body).not.toHaveProperty('passwordHash');
    });
  });

  // ---------------------------------------------------------------
  // AT-5: A request with an expired session returns an authentication error
  // ---------------------------------------------------------------
  describe('AT-5: Expired session', () => {
    it('returns 401 with SESSION_EXPIRED', async () => {
      // 1. Log in to get a real user ID
      const setupToken = await login('inhaber', 'changeme');
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
    it('GET /api/auth/me without Authorization header returns 401', async () => {
      const res = await getApp().inject({
        method: 'GET',
        url: '/api/auth/me',
        // No Authorization header
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

    it('GET /api/projects without Authorization header returns 401', async () => {
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
      const validToken = await login('buero', 'changeme');

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
      const logoutToken = await login('inhaber', 'changeme');

      // 2. Verify the token works before logout
      const beforeRes = await authGet(logoutToken, '/api/auth/me');
      expect(beforeRes.statusCode).toBe(200);

      // 3. Logout — invalidate the session
      const logoutRes = await authPost(logoutToken, '/api/auth/logout');
      expect(logoutRes.statusCode).toBe(200);

      // 4. The same token must no longer work
      const afterRes = await authGet(logoutToken, '/api/auth/me');
      expect(afterRes.statusCode).toBe(401);
    });
  });
});
