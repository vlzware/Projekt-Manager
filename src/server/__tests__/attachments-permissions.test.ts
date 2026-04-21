/**
 * API integration tests — attachment permission matrix (api.md §14.3;
 * the coarse gate clause of AC-215).
 *
 * Pins the 4-role x 3-operation matrix from api.md §14.3:
 *
 *                   | read | write | delete
 *   ----------------|------|-------|--------
 *   owner           |  Y   |   Y   |   Y
 *   office          |  Y   |   Y   |   Y
 *   worker          |  Y*  |   Y*  |   Y* (author + grace)
 *   bookkeeper      |  Y   |   N   |   N
 *
 *   (*) Worker capabilities are additionally scoped at the repository
 *       and service layers — covered in attachments-scope.test.ts
 *       (AC-214, AC-217). AC-215's grace-window branches also live
 *       here since the permission gate and the grace check share the
 *       DELETE surface.
 *
 * Pattern mirrors permissions.test.ts — a coarse gate per role, with
 * the scope/extent carved out to its own file to preserve T-ACBS
 * (one concern per test).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authDelete,
  createTestUserSession,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

const year = new Date().getFullYear();

/** A project worker1 is assigned to so worker write arms hit the service layer. */
async function workerReachableProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (r) => r.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

async function seedReadyAttachment(projectId: string, createdBy: string | null): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         original_key, thumb_key, has_thumbnail, created_by)
      VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
              ${'f-' + id.slice(0, 6)}, 'application/pdf', 100,
              ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE, ${createdBy})
    `);
    return id;
  } finally {
    await pool.end();
  }
}

describe('Attachment permission matrix (api.md §14.3 + AC-215)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;
  /** A user with no roles — every operation must 403. */
  let noPermsToken: string;
  let workerUserId: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
    const none = await createTestUserSession({ roles: [] });
    noPermsToken = none.token;

    projectId = await workerReachableProjectId(ownerToken);
    const me = await authGet(workerToken, '/api/auth/me');
    workerUserId = me.json().user.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // attachment:read — owner, office, worker (scoped), bookkeeper
  // -------------------------------------------------------------------
  describe('read (list) — attachment:read gate', () => {
    it.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
      ['worker', () => workerToken],
      ['bookkeeper', () => bookkeeperToken],
    ] as const)('%s receives 200 on list (holds attachment:read)', async (_label, getToken) => {
      const res = await authGet(getToken(), `/api/projects/${projectId}/attachments`);
      expect(res.statusCode).toBe(200);
    });

    it('user with no roles receives 403 NOT_PERMITTED', async () => {
      const res = await authGet(noPermsToken, `/api/projects/${projectId}/attachments`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // -------------------------------------------------------------------
  // attachment:write — owner, office, worker (bookkeeper denied)
  // -------------------------------------------------------------------
  describe('write (init) — attachment:write gate', () => {
    it('bookkeeper is rejected with 403 NOT_PERMITTED — lacks attachment:write', async () => {
      const res = await authPost(bookkeeperToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'rechnung',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('user with no roles is rejected with 403 NOT_PERMITTED', async () => {
      const res = await authPost(noPermsToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'rechnung',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
    ] as const)(
      '%s passes the permission gate (may 201 or 422 downstream)',
      async (_label, getToken) => {
        const res = await authPost(getToken(), `/api/projects/${projectId}/attachments/init`, {
          fileName: 'gate.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 100,
          label: 'sonstiges',
          hasThumbnail: false,
        });
        // The gate must not reject with 403 — the permission is held.
        // A downstream 422 (validation) or 201 (success) are both
        // acceptable signals that the gate did NOT fire.
        expect(res.statusCode).not.toBe(403);
      },
    );

    it('worker assigned to the project passes the permission gate', async () => {
      const res = await authPost(workerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'worker.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).not.toBe(403);
    });
  });

  // -------------------------------------------------------------------
  // attachment:delete — owner, office, worker (author + grace);
  // bookkeeper denied at the permission gate alone (never reaches
  // authorship / grace branches).
  // -------------------------------------------------------------------
  describe('delete — attachment:delete gate', () => {
    it('bookkeeper is rejected with 403 NOT_PERMITTED — lacks attachment:delete', async () => {
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(bookkeeperToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('user with no roles is rejected with 403 NOT_PERMITTED', async () => {
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(noPermsToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('owner deletes any attachment — returns 200/204', async () => {
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(ownerToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBeLessThan(300);
    });

    it('office deletes any attachment — returns 200/204', async () => {
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(officeToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBeLessThan(300);
    });

    it('worker deleting their own attachment within the grace window succeeds (AC-215)', async () => {
      // Seed a row whose createdBy IS the worker and whose createdAt is
      // fresh (the default NOW()). The grace window is 15 minutes per
      // architecture.md §12.2; freshly created rows are well within it.
      const id = await seedReadyAttachment(projectId, workerUserId);
      const res = await authDelete(workerToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBeLessThan(300);
    });

    it("worker deleting another's attachment is rejected with 403 NOT_PERMITTED (AC-215)", async () => {
      // createdBy = owner-ish (null here — no real owner mattered).
      // Either way the author is not the worker.
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(workerToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker deleting their own attachment AFTER the grace window is rejected with 403 (AC-215)', async () => {
      // Backdate createdAt beyond the 15-minute default grace — the
      // worker authored the row but the service must refuse. 24 hours
      // in the past is safely outside any reasonable deployment's
      // self-delete grace window.
      const id = await seedReadyAttachment(projectId, workerUserId);
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          UPDATE attachments
          SET created_at = NOW() - INTERVAL '24 hours'
          WHERE id = ${id}
        `);
      } finally {
        await pool.end();
      }
      const res = await authDelete(workerToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });
});
