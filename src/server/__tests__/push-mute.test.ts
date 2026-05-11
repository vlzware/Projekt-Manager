/**
 * Push-mute integration tests — Iteration 8, issue #112.
 *
 * Pins AC-195 (push-mute) via AT-103 from the traceability matrix.
 * `notification-publisher.test.ts` covers mute from the publisher's
 * angle; this file covers mute from the self-update API + subscription
 * persistence angle — the two sides of the contract, split for
 * T-ACBS clarity.
 *
 * Failing-state expectations (step 3):
 *   - `PATCH /api/auth/me` does not yet accept `pushMuted` → 400 / 422.
 *   - `push_subscriptions` table does not exist → COUNT raises
 *     "relation does not exist".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { startApp, stopApp, login, authGet, authPost, authPatch } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

// ---------------------------------------------------------------------
// AC-195 — pushMuted controls push delivery, not activity-feed inclusion
// ---------------------------------------------------------------------
describe('AC-195: pushMuted toggles push delivery; rows retained; feed unaffected', () => {
  let ownerToken: string;
  let ownerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const { db, pool } = createDatabase();
    try {
      const rows = await db.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      ownerId = (rows.rows[0] as { id: string }).id;
    } finally {
      await pool.end();
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  async function subscriptionCount(userId: string): Promise<number> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE user_id = ${userId}`,
      );
      return (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }
  }

  it('PATCH /api/auth/me with pushMuted=true persists the value and is reflected by GET /api/auth/me', async () => {
    // Precondition: reset to false so the assertion is observable.
    const reset = await authPatch(ownerToken, '/api/auth/me', { pushMuted: false });
    expect(reset.statusCode).toBe(200);

    const muteRes = await authPatch(ownerToken, '/api/auth/me', { pushMuted: true });
    expect(muteRes.statusCode).toBe(200);
    const after = muteRes.json() as { user: { pushMuted?: boolean } };
    expect(after.user.pushMuted).toBe(true);

    const getRes = await authGet(ownerToken, '/api/auth/me');
    expect(getRes.statusCode).toBe(200);
    const me = getRes.json() as { user: { pushMuted?: boolean } };
    expect(me.user.pushMuted).toBe(true);
  });

  it('PATCH /api/auth/me rejects non-boolean pushMuted as 422 VALIDATION_ERROR', async () => {
    const res = await authPatch(ownerToken, '/api/auth/me', {
      pushMuted: 'not-a-boolean',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('muting does not delete the owner’s push_subscription rows', async () => {
    // Register a subscription, mute, assert the row count is unchanged.
    const endpoint = `https://push.test.example/ac195-persist-${Date.now().toString(36)}`;
    const sub = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(sub.statusCode).toBeLessThan(300);

    const before = await subscriptionCount(ownerId);
    expect(before).toBeGreaterThan(0);

    await authPatch(ownerToken, '/api/auth/me', { pushMuted: true });

    const after = await subscriptionCount(ownerId);
    // Mute is a delivery-time filter — rows MUST remain.
    expect(after).toBe(before);
  });
});
