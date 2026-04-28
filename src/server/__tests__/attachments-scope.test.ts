/**
 * API integration tests — attachment scope (AC-214, AC-217).
 *
 * Pins the `attachmentScopeForCaller` repository predicate and the
 * worker-scope service gate:
 *
 *   - Owner, office, bookkeeper → unscoped (see every attachment row
 *     regardless of project assignment).
 *   - Worker → scoped by `project_workers` — sees only attachments on
 *     projects they are assigned to.
 *
 *   - List / init / complete on an unassigned project → 403 NOT_PERMITTED.
 *   - Any attachment endpoint on a non-existent project id → 404 NOT_FOUND.
 *
 *   - get-by-id three-way result (200 in-scope / 403 out-of-scope /
 *     404 missing) mirrors the project pattern in AC-147 /
 *     role-scoping.test.ts. AC-217 pins the symmetry explicitly.
 *
 * Fixtures:
 *   - Worker1 (SEED_USERS.worker1, "arbeiter1") is assigned to YYYY-007,
 *     -008, -009, -011 per src/server/seed/business.ts. We use -007
 *     as the in-scope project and -001 (unassigned) as the out-of-scope
 *     project.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';
import { createDatabase } from '../db/connection.js';

const year = new Date().getFullYear();

async function projectIdByNumber(ownerToken: string, number: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find((r) => r.number === number);
  if (!p) throw new Error(`seed missing ${number}`);
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

describe('Attachment scope (AC-214, AC-217)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  let assignedProjectId: string;
  let unassignedProjectId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
    assignedProjectId = await projectIdByNumber(ownerToken, `${year}-007`);
    unassignedProjectId = await projectIdByNumber(ownerToken, `${year}-001`);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // AC-214 — Worker attachment ops on unassigned project → 403.
  //          Non-existent project id → 404.
  // -------------------------------------------------------------------
  describe('AC-214: worker service-layer scope on init / complete / list', () => {
    it('worker list on an unassigned project returns 403 NOT_PERMITTED', async () => {
      const res = await authGet(workerToken, `/api/projects/${unassignedProjectId}/attachments`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker init on an unassigned project returns 403 NOT_PERMITTED', async () => {
      const res = await authPost(
        workerToken,
        `/api/projects/${unassignedProjectId}/attachments/init`,
        binaryInitBody({ fileName: 'x.pdf', sizeBytes: 100, label: 'sonstiges' }),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker complete on an unassigned project returns 403 NOT_PERMITTED', async () => {
      // An attachment on an unassigned project. Its id matters for the
      // route, but the scope check rejects before the row is even
      // fetched — just using any uuid is sufficient.
      const res = await authPost(
        workerToken,
        `/api/projects/${unassignedProjectId}/attachments/${crypto.randomUUID()}/complete`,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker hit on a non-existent project id returns 404 NOT_FOUND (distinguishable from 403)', async () => {
      const missingId = '00000000-0000-0000-0000-000000000099';
      const res = await authGet(workerToken, `/api/projects/${missingId}/attachments`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('owner and office see attachments on any project (regression — unscoped)', async () => {
      const ownerRes = await authGet(
        ownerToken,
        `/api/projects/${unassignedProjectId}/attachments`,
      );
      expect(ownerRes.statusCode).toBe(200);

      const officeRes = await authGet(
        officeToken,
        `/api/projects/${unassignedProjectId}/attachments`,
      );
      expect(officeRes.statusCode).toBe(200);

      const bookkeeperRes = await authGet(
        bookkeeperToken,
        `/api/projects/${unassignedProjectId}/attachments`,
      );
      expect(bookkeeperRes.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // AC-217 — Three-way get-by-id (200 / 403 / 404) mirrors AC-147.
  //
  // The download-url endpoint is the natural get-by-id surface for an
  // attachment — it's the one caller-facing read path that keys off an
  // attachment id. Delete is a mutation; list is collection-scoped.
  // -------------------------------------------------------------------
  describe('AC-217: download-url three-way (200 / 403 / 404)', () => {
    let inScopeAttachmentId: string;
    let outOfScopeAttachmentId: string;

    beforeAll(async () => {
      inScopeAttachmentId = await seedReadyAttachment(assignedProjectId, null);
      outOfScopeAttachmentId = await seedReadyAttachment(unassignedProjectId, null);
    });

    it('worker receives 200 for an attachment on an assigned project', async () => {
      const res = await authGet(
        workerToken,
        `/api/projects/${assignedProjectId}/attachments/${inScopeAttachmentId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(200);
    });

    it('worker receives 403 NOT_PERMITTED for an attachment on an unassigned project', async () => {
      const res = await authGet(
        workerToken,
        `/api/projects/${unassignedProjectId}/attachments/${outOfScopeAttachmentId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker receives 404 NOT_FOUND for a non-existent attachment id', async () => {
      const missingId = '00000000-0000-0000-0000-00000000feed';
      const res = await authGet(
        workerToken,
        `/api/projects/${assignedProjectId}/attachments/${missingId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
      ['bookkeeper', () => bookkeeperToken],
    ] as const)(
      '%s receives 200 for any attachment (regression — unscoped)',
      async (_label, getToken) => {
        // Out-of-scope for a scoped worker, but the unscoped roles must
        // still see it — that is the AC-217 contract (attachment:read is
        // unscoped for owner/office/bookkeeper).
        const res = await authGet(
          getToken(),
          `/api/projects/${unassignedProjectId}/attachments/${outOfScopeAttachmentId}/download-url?variant=original`,
        );
        expect(res.statusCode).toBe(200);
      },
    );
  });

  // -------------------------------------------------------------------
  // List scoping — worker sees only own-project rows (AC-217 list arm).
  // -------------------------------------------------------------------
  describe('AC-217: list narrows by predicate for worker', () => {
    it('worker list on an assigned project returns only rows for that project', async () => {
      // Seed two rows: one on the assigned project, one on an
      // unassigned project. List on the assigned project must not
      // leak the unassigned row (they live on different projects, so
      // the project-in-URL already filters — this test pins that the
      // WHERE predicate inside `listByProject` does NOT ignore the
      // scope fragment for the scoped caller).
      await seedReadyAttachment(assignedProjectId, null);
      await seedReadyAttachment(unassignedProjectId, null);

      const res = await authGet(workerToken, `/api/projects/${assignedProjectId}/attachments`);
      expect(res.statusCode).toBe(200);
      const rows = (res.json().data as { projectId: string }[]) ?? [];
      // Guard against empty-result regression — an empty `rows` would
      // let the per-row assertion below pass vacuously, masking a
      // predicate that accidentally filters everything out.
      expect(rows.length).toBeGreaterThan(0);
      // Every returned row must belong to the assigned project.
      for (const row of rows) {
        expect(row.projectId).toBe(assignedProjectId);
      }
    });
  });

  // Suppress unused-warning for authDelete — kept imported so future
  // delete-scope tests can land here without re-threading the helper.
  void authDelete;
});
