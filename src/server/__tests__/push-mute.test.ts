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
 *   - The publisher module does not yet exist → the dynamic import
 *     fails with MODULE_NOT_FOUND.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { startApp, stopApp, login, authGet, authPost, authPatch } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

interface DispatchObservation {
  auditEntryId: string;
  ruleMatches: string[];
  recipients: string[];
  pushAttemptedUserIds: string[];
}

async function loadPublisher() {
  const path = '../services/notification-publisher.js';
  return (await import(/* @vite-ignore */ path)) as {
    onEventDispatched: (h: (entry: DispatchObservation) => void) => () => void;
  };
}

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

  it('muting suppresses push attempts to the owner’s subscriptions but leaves activity-feed inclusion intact', async () => {
    const pub = await loadPublisher();

    // Register a subscription so there is at least one candidate
    // target to mute against.
    const endpoint = `https://push.test.example/ac195-suppress-${Date.now().toString(36)}`;
    const sub = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(sub.statusCode).toBeLessThan(300);

    // Mute.
    await authPatch(ownerToken, '/api/auth/me', { pushMuted: true });

    // Create a rule targeting the owner.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [ownerId] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsub = pub.onEventDispatched((e) => observations.push(e));

    let transitionAuditId: string;
    try {
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      const res = await authPost(ownerToken, `/api/projects/${target!.id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);

      // Resolve this transition's audit id so the observation lookup
      // names the specific event rather than relying on "last in
      // observations" — a sibling test could have produced entries.
      const { db: d, pool: p } = createDatabase();
      try {
        const row = await d.execute(sql`
          SELECT id FROM audit_log
          WHERE entity_type = 'project' AND entity_id = ${target!.id}
            AND action = 'transition:forward'
          ORDER BY created_at DESC, id DESC LIMIT 1
        `);
        transitionAuditId = (row.rows[0] as { id: string }).id;
      } finally {
        await p.end();
      }

      const obs = observations.find((o) => o.auditEntryId === transitionAuditId);
      expect(obs).toBeDefined();
      // Owner IS a dispatch recipient (dispatch set unaffected by mute).
      expect(obs!.recipients).toContain(ownerId);
      // Owner is NOT in pushAttemptedUserIds (mute filter applied).
      expect(obs!.pushAttemptedUserIds).not.toContain(ownerId);
    } finally {
      unsub();
    }

    // AC-195 activity-feed clause: the transition's audit row IS
    // retrievable via GET /api/audit — mute only suppresses push,
    // feed inclusion is independent. Matching by transitionAuditId
    // ensures we see THIS event, not a sibling.
    const auditRes = await authGet(ownerToken, '/api/audit?limit=50');
    expect(auditRes.statusCode).toBe(200);
    const auditIds = (auditRes.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(auditIds).toContain(transitionAuditId);
  });

  it('unmuting (pushMuted=false) restores delivery on the next event — no re-subscribe required', async () => {
    const pub = await loadPublisher();

    // Precondition: the owner has at least one push_subscription row
    // left over from earlier describe-block tests. This assertion
    // pins the AC clause "subscriptions remain registered through the
    // mute" — if row retention regressed, the AC breaks BEFORE the
    // dispatch observation can speak to it.
    expect(await subscriptionCount(ownerId)).toBeGreaterThan(0);

    // Unmute.
    const unmute = await authPatch(ownerToken, '/api/auth/me', { pushMuted: false });
    expect(unmute.statusCode).toBe(200);

    // Create a rule targeting the owner.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [ownerId] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsub = pub.onEventDispatched((e) => observations.push(e));

    try {
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      const res = await authPost(ownerToken, `/api/projects/${target!.id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);

      const { db: d, pool: p } = createDatabase();
      let auditEntryId: string;
      try {
        const row = await d.execute(sql`
          SELECT id FROM audit_log
          WHERE entity_type = 'project' AND entity_id = ${target!.id}
            AND action = 'transition:forward'
          ORDER BY created_at DESC, id DESC LIMIT 1
        `);
        auditEntryId = (row.rows[0] as { id: string }).id;
      } finally {
        await p.end();
      }

      const obs = observations.find((o) => o.auditEntryId === auditEntryId);
      expect(obs).toBeDefined();
      // Owner's subscription was retained through the mute cycle —
      // delivery resumed without any re-subscribe round-trip.
      expect(obs!.pushAttemptedUserIds).toContain(ownerId);
    } finally {
      unsub();
    }
  });
});
