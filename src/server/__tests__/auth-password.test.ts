/**
 * API integration tests: Password change operations.
 *
 * Tests AT-14 and AT-15 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * Separated from auth.test.ts because AT-7 deactivates the buero user,
 * and AT-14 needs buero active. Each test file gets a fresh seed via
 * startApp(), so isolation requires a separate file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, getApp, login, authPost } from '../../test/api-helpers.js';

describe('Password Change Operations', () => {
  beforeAll(async () => {
    await startApp();
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-14: Change own password with correct current password succeeds
  // ---------------------------------------------------------------
  describe('AT-14: Change own password (success)', () => {
    it('changes password and allows login with the new one', async () => {
      // Self-contained: login, change, verify new password — all in one test.
      // Uses buero to avoid affecting other tests that log in as inhaber.
      const bueroToken = await login('buero', 'changeme');

      const changeRes = await authPost(bueroToken, '/api/auth/change-password', {
        currentPassword: 'changeme',
        newPassword: 'neuesPasswort123!',
      });

      expect(changeRes.statusCode).toBe(200);

      // Verify the new password works by logging in again
      const loginRes = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'buero', password: 'neuesPasswort123!' },
      });

      expect(loginRes.statusCode).toBe(200);
      // Session token is now in the cookie, not the body
      const setCookie = loginRes.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toMatch(/session=[^;]+/);
    });
  });

  // ---------------------------------------------------------------
  // AT-15: Change own password with incorrect current password is rejected
  // ---------------------------------------------------------------
  describe('AT-15: Change own password (wrong current password)', () => {
    it('rejects when current password is incorrect', async () => {
      // Uses inhaber — completely independent of AT-14's buero flow.
      const inhaberToken = await login('inhaber', 'changeme');

      const res = await authPost(inhaberToken, '/api/auth/change-password', {
        currentPassword: 'definitelywrong',
        newPassword: 'newpassword123!',
      });

      // Should not succeed
      expect(res.statusCode).not.toBe(200);
      // 401 or 422 are both reasonable; the spec says "rejected"
      expect([401, 422]).toContain(res.statusCode);

      const body = res.json();
      expect(body.code).toBeDefined();
      expect(typeof body.message).toBe('string');
    });

    it('does not change the password on rejection', async () => {
      // After the failed attempt, original password should still work.
      // Logs in fresh — no dependency on any prior test state.
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'inhaber', password: 'changeme' },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
