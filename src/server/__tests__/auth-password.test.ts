/**
 * API integration tests: Password change operations.
 *
 * Tests AT-14 and AT-15 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * Separated from auth.test.ts because AT-7 deactivates the office user,
 * and AT-14 needs that same user active. Each test file gets a fresh seed
 * via startApp(), so isolation requires a separate file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, getApp, login, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

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
      // Uses the office user to avoid affecting other tests that log in as owner.
      // The rotated password is a throwaway literal — it's the NEW value, not
      // a seed reference, so it stays hardcoded here.
      const officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);

      const changeRes = await authPost(officeToken, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: 'neuesPasswort123!',
      });

      expect(changeRes.statusCode).toBe(200);

      // Verify the new password works by logging in again
      const loginRes = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.office.username, password: 'neuesPasswort123!' },
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
      // Uses owner — completely independent of AT-14's office-user flow.
      const ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

      const res = await authPost(ownerToken, '/api/auth/change-password', {
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
        payload: { username: SEED_USERS.owner.username, password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------
  // Password policy — shared with bootstrap via password-policy.ts
  // ---------------------------------------------------------------
  describe('Password policy enforcement on change-password', () => {
    it('rejects a blocklist entry as the new password', async () => {
      // Self-contained: uses worker1 to avoid side effects on other tests.
      const token = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const res = await authPost(token, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: 'qwerty123',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects a new password shorter than 8 characters', async () => {
      const token = await login(SEED_USERS.worker2.username, SEED_DEFAULT_PASSWORD);
      const res = await authPost(token, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: 'short1!',
      });
      // 422 from the service's checkPasswordPolicy call. Not 400 from the
      // JSON schema, because the schema's minLength is now 1 — the full
      // policy lives in the service layer so it cannot diverge from the
      // bootstrap path.
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    // Regression test for the UTF-8 byte-length bug found by the security
    // audit on issue #57. Before the fix, the change-password schema had
    // maxLength:72 (characters), and a password like '测'.repeat(25) is 25
    // characters but 75 UTF-8 bytes — it would sneak past the schema and
    // bcrypt would silently truncate to the first ~24 characters.
    it('rejects a UTF-8 password whose bytes exceed 72 despite having fewer characters', async () => {
      const token = await login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD);
      const utf8Pw = '测'.repeat(25); // 25 chars, 75 bytes
      expect(utf8Pw.length).toBe(25);
      expect(Buffer.byteLength(utf8Pw, 'utf8')).toBe(75);

      const res = await authPost(token, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: utf8Pw,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');

      // And the original password must still work — confirming no partial
      // mutation on the rejection path.
      const loginRes = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: SEED_USERS.bookkeeper.username,
          password: SEED_DEFAULT_PASSWORD,
        },
      });
      expect(loginRes.statusCode).toBe(200);
    });

    it('accepts a 72-ASCII-byte password at the boundary', async () => {
      // Counterpart to the UTF-8 test — a 72-character ASCII password is
      // exactly 72 bytes, which is the boundary value and must be allowed.
      const token = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      const at72 = 'A'.repeat(72);
      expect(Buffer.byteLength(at72, 'utf8')).toBe(72);

      const res = await authPost(token, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: at72,
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
