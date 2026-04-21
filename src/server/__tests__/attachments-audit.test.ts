/**
 * API integration tests — attachment audit contract (AC-219).
 *
 * Pins the single-write-path invariant (AC-177, ADR-0021) as it
 * applies to the attachment sub-entity:
 *
 *   - Init writes exactly one `attachment:add` audit row with
 *     `entityType='project'`, `entityId=projectId`, and a payload
 *     `after` naming attachmentId, label, mimeType, sizeBytes.
 *   - Delete writes exactly one `attachment:remove` audit row with
 *     `entityType='project'`, `entityId=projectId`, and a payload
 *     `before` naming the same fields.
 *   - Complete is a state-machine finalize — it produces NO audit
 *     row. The `attachment:add` entry is the authoritative record.
 *
 * Attachment is audited as a sub-entity under the owning project
 * (data-model.md §5.10, verification.md AC-179 Part 2): there is no
 * `attachment` member on `AuditEntityType`, so every attachment audit
 * row carries `entityType='project'`. The architecture check
 * (scripts/check-audit-mutations.sh) asserts the `attachment` table
 * is included in its audited-table set — covered in
 * attachments-architecture.test.ts.
 *
 * Raw-SQL attachment-row seeding is permitted here — the `__tests__/`
 * prefix is allowlisted by the architecture check (AC-179).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';

const year = new Date().getFullYear();

async function countAuditRows(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

async function fetchLatestAuditRow(
  entityId: string,
  action: string,
): Promise<Record<string, unknown> | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`
      SELECT id, entity_type, entity_id, action, actor_id, actor_kind, payload
      FROM audit_log
      WHERE entity_id = ${entityId} AND action = ${action}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return (res.rows[0] as Record<string, unknown>) ?? null;
  } finally {
    await pool.end();
  }
}

async function projectIdByNumber(ownerToken: string, number: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find((r) => r.number === number);
  if (!p) throw new Error(`seed missing ${number}`);
  return p.id;
}

describe('Attachment audit contract (AC-219)', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await projectIdByNumber(ownerToken, `${year}-007`);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // init → exactly one `attachment:add` audit row
  // -------------------------------------------------------------------
  it('init writes exactly one attachment:add row with entityType=project and expected payload fields', async () => {
    const before = await countAuditRows();

    const initRes = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
      fileName: 'vertrag-audit.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4321,
      label: 'rechnung',
      hasThumbnail: false,
    });
    expect(initRes.statusCode).toBe(201);
    const attachmentId = initRes.json().attachment.id as string;

    const after = await countAuditRows();
    expect(after - before).toBe(1);

    const row = await fetchLatestAuditRow(projectId, 'attachment:add');
    expect(row).not.toBeNull();
    expect(row!.entity_type).toBe('project');
    expect(row!.entity_id).toBe(projectId);
    expect(row!.action).toBe('attachment:add');
    expect(row!.actor_kind).toBe('user');
    expect(row!.actor_id).not.toBeNull();

    const payload = row!.payload as { after?: Record<string, unknown> };
    expect(payload.after).toBeDefined();
    expect(payload.after!.attachmentId).toBe(attachmentId);
    expect(payload.after!.label).toBe('rechnung');
    expect(payload.after!.mimeType).toBe('application/pdf');
    expect(payload.after!.sizeBytes).toBe(4321);
  });

  // -------------------------------------------------------------------
  // complete → NO audit row (state-machine finalize)
  // -------------------------------------------------------------------
  it('complete writes zero audit rows — the attachment:add entry is authoritative', async () => {
    // Seed a pending attachment with backing bytes so complete()
    // succeeds. Counting audit rows must include whatever init
    // produced; we record the "after init" mark and compare after
    // complete.
    const initRes = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
      fileName: 'complete-zero-audit.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 120_000,
      label: 'foto',
      hasThumbnail: true,
    });
    expect(initRes.statusCode).toBe(201);
    const body = initRes.json();
    const attachmentId = body.attachment.id as string;

    // Stage backing bytes so the HEAD verify succeeds.
    const env = getEnv();
    const s = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
    });
    await s.upload(body.attachment.originalKey, Buffer.alloc(120_000, 0xff), 'image/jpeg');
    await s.upload(body.attachment.thumbKey, Buffer.from('webp-thumb'), 'image/webp');

    const afterInit = await countAuditRows();

    const completeRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/${attachmentId}/complete`,
    );
    expect(completeRes.statusCode).toBe(200);

    const afterComplete = await countAuditRows();
    // No new audit row from complete — spec AC-219.
    expect(afterComplete - afterInit).toBe(0);
  });

  // -------------------------------------------------------------------
  // delete → exactly one `attachment:remove` audit row
  // -------------------------------------------------------------------
  it('delete writes exactly one attachment:remove row with before payload fields', async () => {
    // Seed directly — we don't need the real upload path here; the
    // delete API takes a ready row and removes it. Raw SQL is
    // allowlisted under __tests__/.
    const { db, pool } = createDatabase();
    const attachmentId = crypto.randomUUID();
    try {
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           original_key, thumb_key, has_thumbnail, created_by)
        VALUES (${attachmentId}, ${projectId}, 'ready', 'binary', 'angebot',
                'angebot-2026.pdf', 'application/pdf', 9876,
                ${`attachments/${projectId}/${attachmentId}.orig`}, NULL, FALSE, NULL)
      `);
    } finally {
      await pool.end();
    }

    const before = await countAuditRows();

    const res = await authDelete(
      ownerToken,
      `/api/projects/${projectId}/attachments/${attachmentId}`,
    );
    expect(res.statusCode).toBeLessThan(300);

    const after = await countAuditRows();
    expect(after - before).toBe(1);

    const row = await fetchLatestAuditRow(projectId, 'attachment:remove');
    expect(row).not.toBeNull();
    expect(row!.entity_type).toBe('project');
    expect(row!.entity_id).toBe(projectId);
    expect(row!.action).toBe('attachment:remove');
    expect(row!.actor_kind).toBe('user');

    const payload = row!.payload as { before?: Record<string, unknown> };
    expect(payload.before).toBeDefined();
    expect(payload.before!.attachmentId).toBe(attachmentId);
    expect(payload.before!.label).toBe('angebot');
    expect(payload.before!.mimeType).toBe('application/pdf');
    expect(payload.before!.sizeBytes).toBe(9876);
  });
});
