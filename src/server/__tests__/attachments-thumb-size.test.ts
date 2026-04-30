/**
 * API integration tests — thumbnail size cap + complete-side HEAD
 * re-assertion (AC-245 / AC-212 thumb defence in depth).
 *
 * Two regression surfaces are pinned here:
 *
 *   1. `thumbSizeBytes > perThumbCapBytes` is rejected at init with 422
 *      and persists no row. The thumbnail pipeline emits 3-30 KB WebP
 *      blobs (`attachmentPipeline.ts` — 320 px shortest edge / q=0.72);
 *      a client declaring a 1 MB "thumbnail" is a policy bypass.
 *
 *   2. `thumbSizeBytes` is persisted on the row at init and re-asserted
 *      against HEAD at `complete()`. Mirrors the original-side
 *      `sizeBytes` re-assertion — without this branch, the SigV4
 *      `Content-Length` pin is the sole defence; a signature bypass
 *      could land arbitrary bytes under the thumb key.
 *
 * Direct-storage uploads bypass the SigV4 path so the complete-side
 * HEAD check can be exercised in isolation. Same pattern the existing
 * AC-212 arms in `attachments-routes.test.ts` use for the original-
 * side size-mismatch case.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import { ATTACHMENT_CONFIG } from '../../config/attachmentConfig.js';
import { photoInitBody } from '../../test/fixtures/attachmentInit.js';

const year = new Date().getFullYear();

function storage() {
  const env = getEnv();
  return createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
}

async function seededProjectIdForOwner(ownerToken: string): Promise<string> {
  // Owner is unscoped; YYYY-007 is a known seeded project also reachable
  // by worker1 (used here for parity with attachments-routes.test.ts).
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

async function countAttachmentRows(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM attachments`);
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

async function fetchAttachmentStatus(id: string): Promise<string | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT status FROM attachments WHERE id = ${id} LIMIT 1`);
    const row = res.rows[0] as { status: string } | undefined;
    return row?.status ?? null;
  } finally {
    await pool.end();
  }
}

async function fetchPersistedThumbSize(id: string): Promise<number | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT thumb_size_bytes FROM attachments WHERE id = ${id} LIMIT 1`,
    );
    const row = res.rows[0] as { thumb_size_bytes: number | string | null } | undefined;
    if (!row || row.thumb_size_bytes === null) return null;
    // bigint columns come back as string for some drivers; coerce.
    return typeof row.thumb_size_bytes === 'string'
      ? Number(row.thumb_size_bytes)
      : row.thumb_size_bytes;
  } finally {
    await pool.end();
  }
}

describe('Attachment thumbnail-size cap + HEAD re-assertion', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await seededProjectIdForOwner(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // Init validation — `thumbSizeBytes > perThumbCapBytes` is the cap
  // bypass the original code missed (it gated thumbs against the
  // per-FILE cap, an order of magnitude larger than the real ceiling).
  // -------------------------------------------------------------------
  describe('init: thumbnail-size cap', () => {
    it('rejects thumbSizeBytes > perThumbCapBytes with 422 and no row', async () => {
      const before = await countAttachmentRows();
      const overCap = ATTACHMENT_CONFIG.perThumbCapBytes + 1;
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInitBody({ thumbSizeBytes: overCap }),
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('accepts a small thumbSizeBytes (8 KB) with 201 and persists it on the row', async () => {
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInitBody({ thumbSizeBytes: 8000 }),
      );
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.attachment.id).toBeDefined();
      expect(body.attachment.status).toBe('pending');

      // The row must carry the declared thumb size — that's the data
      // the complete-side HEAD check re-asserts against.
      const persisted = await fetchPersistedThumbSize(body.attachment.id);
      expect(persisted).toBe(8000);

      // The presigned PUT pins the same value into Content-Length —
      // the SigV4 layer is the first defence; the persisted row + HEAD
      // re-assertion is the second.
      expect(body.thumbnailUpload.headers['Content-Length']).toBe('8000');
    });
  });

  // -------------------------------------------------------------------
  // complete() — HEAD re-assertion against the persisted thumb size.
  //
  // Direct-storage upload bypasses the SigV4 Content-Length pin so the
  // service-layer guard is the only thing standing between a thumb-size
  // mismatch and a `ready` row. Mirrors the existing original-side
  // mismatch arm in attachments-routes.test.ts.
  // -------------------------------------------------------------------
  describe('complete: thumbnail HEAD re-assertion', () => {
    it('returns 409 CONFLICT when stored thumb size differs from declared thumbSizeBytes', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInitBody({ thumbSizeBytes: 8000 }),
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();

      // Original matches the row's declared sizeBytes (120000) so the
      // original-side HEAD passes — the failure must come from the
      // thumb branch alone.
      await s.upload(body.attachment.originalKey, Buffer.alloc(120_000, 0xff), 'image/jpeg');
      // Upload a thumb of WRONG size (1 byte vs the row's 8000). HEAD
      // reports 1, the row says 8000 → declared-size mismatch.
      await s.upload(body.attachment.thumbKey, Buffer.from('x'), 'image/webp');

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');

      // Row stays pending; the reaper is the only remover.
      const status = await fetchAttachmentStatus(body.attachment.id);
      expect(status).toBe('pending');
    });

    it('flips pending → ready when stored thumb size matches declared thumbSizeBytes', async () => {
      // Sanity arm — confirms the new HEAD assertion does not over-reject
      // the happy path. A regression that toughens the predicate to
      // strict-equality on a non-null value already satisfies this; an
      // accidental flip to `!==` (always-false) would break it.
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInitBody({ thumbSizeBytes: 12 }),
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();

      await s.upload(body.attachment.originalKey, Buffer.alloc(120_000, 0xff), 'image/jpeg');
      // 12 bytes — matches the declared thumbSizeBytes exactly.
      await s.upload(body.attachment.thumbKey, Buffer.from('webp-thumb12'), 'image/webp');

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ready');
    });
  });
});
