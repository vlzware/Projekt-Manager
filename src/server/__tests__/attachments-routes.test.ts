/**
 * API integration tests — attachment route surface (issue #108).
 *
 * Pins the HTTP contract for every endpoint on
 * `/api/projects/:id/attachments/...` against the spec in api.md §14.2.11
 * and the error paths in §14.4.1.
 *
 * AC coverage in this file:
 *   - AC-211: init — presigned-POST policy constraints + validation
 *             rejects on MIME / label / size / fileName.
 *   - AC-212: complete — HEAD-verify state machine, 409 on pending→ready
 *             conflict (double ack, size/mime mismatch), 404 when the
 *             reaper has already removed the row.
 *   - AC-216: bulk download — 20-file / 20 MB caps, BULK_LIMIT_EXCEEDED,
 *             cross-project id rejection, pending-in-batch rejection.
 *   - AC-225: upload-failure error envelope categories (maps to the
 *             client banner's "Erneut versuchen" surface).
 *
 * Storage: the test harness points at the real MinIO endpoint
 * (`startApp()` → `validateEnv()`). Direct-storage seeding uses the
 * pattern in backup.test.ts. MinIO is never mocked (CONTRIBUTING.md
 * §Testing "Integration prerequisites").
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

/**
 * Minimal photo-mime init payload used by every happy-path test. The
 * server fixes `originalKey` / `thumbKey` — clients never send them.
 */
function photoInit(projectId: string) {
  return {
    projectId,
    fileName: `test-${crypto.randomUUID().slice(0, 8)}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: 120_000,
    label: 'foto' as const,
    hasThumbnail: true,
  };
}

/**
 * Direct-storage helper — puts bytes under the server-issued key so a
 * complete() HEAD succeeds. Used only by the "happy path" arm; all
 * other complete arms exercise the failure surface.
 */
function storage() {
  const env = getEnv();
  return createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
}

async function seededProjectIdForWorker1(ownerToken: string): Promise<string> {
  // Worker1 (arbeiter1) is assigned to YYYY-007, -008, -009, -011. Pick
  // a project they can reach so positive-scope arms read meaningfully.
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

async function seededProjectIdUnassigned(ownerToken: string): Promise<string> {
  // YYYY-001 is unassigned — the "worker out of scope" arm reads it.
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-001`,
  );
  if (!p) throw new Error(`seed missing ${year}-001`);
  return p.id;
}

describe('Attachment routes — integration (issue #108)', () => {
  let ownerToken: string;
  let workerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
    projectId = await seededProjectIdForWorker1(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // AC-211 — Init validates inputs and returns a signed policy.
  // -------------------------------------------------------------------
  describe('AC-211: init validation + presigned-POST policy', () => {
    it('returns 201 with a pending row and two presigned descriptors for a photo', async () => {
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.attachment).toBeDefined();
      expect(body.attachment.id).toBeDefined();
      expect(body.attachment.status).toBe('pending');
      expect(body.attachment.projectId).toBe(projectId);
      expect(body.attachment.kind).toBe('photo');
      expect(body.attachment.label).toBe('foto');
      expect(body.attachment.mimeType).toBe('image/jpeg');
      // The server fixes the key — clients never supply one.
      expect(typeof body.attachment.originalKey).toBe('string');
      expect(body.attachment.originalKey.length).toBeGreaterThan(0);
      expect(typeof body.attachment.thumbKey).toBe('string');

      expect(body.originalUpload).toBeDefined();
      expect(typeof body.originalUpload.url).toBe('string');
      expect(typeof body.originalUpload.fields).toBe('object');
      expect(body.originalUpload.fields).not.toBeNull();
      expect(typeof body.originalUpload.expiresAt).toBe('string');
      expect(body.thumbnailUpload).toBeDefined();
    });

    it('returns exactly one descriptor (no thumbnail) for a non-photo MIME', async () => {
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'vertrag.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 50_000,
        label: 'rechnung',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.attachment.kind).toBe('binary');
      expect(body.attachment.thumbKey).toBeNull();
      expect(body.thumbnailUpload).toBeUndefined();
    });

    it('pins the presigned policy to the exact originalKey issued on the row', async () => {
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(res.statusCode).toBe(201);
      const body = res.json();
      // The policy's key condition must equal the row's key — a client
      // that swaps the key before POSTing has its upload rejected by
      // storage. Fields carry `key` per S3 presigned-POST shape.
      expect(body.originalUpload.fields.key).toBe(body.attachment.originalKey);
      if (body.thumbnailUpload) {
        expect(body.thumbnailUpload.fields.key).toBe(body.attachment.thumbKey);
      }
    });

    it('rejects a MIME outside the whitelist with 422 VALIDATION_ERROR (no row)', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'evil.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 100,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      const after = await countAttachmentRows();
      expect(after).toBe(before);
    });

    it('rejects a label outside the enum with 422 VALIDATION_ERROR (no row)', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'not-in-enum',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects sizeBytes > configured cap with 422 VALIDATION_ERROR', async () => {
      // Default per-file cap is 1 MB (architecture.md §12.2). 10 MB is
      // safely above regardless of a deployment-specific tune. The test
      // pins the spec behavior, not a specific deployment constant —
      // when the cap is raised, increase this too.
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'huge.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10 * 1024 * 1024,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects empty fileName with 422 VALIDATION_ERROR', async () => {
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: '',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects fileName longer than 255 characters with 422 VALIDATION_ERROR', async () => {
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: `${'a'.repeat(256)}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects a client-supplied originalKey — the server owns the key', async () => {
      // A well-formed request carrying an extra `originalKey` field must
      // not be honored. Either the server ignores the field (and issues
      // its own key — asserted here by shape mismatch) or it rejects as
      // 422. Either is acceptable; what must NOT happen is the client's
      // key appearing on the row.
      const injectedKey = 'attacker/controlled/path.jpg';
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        originalKey: injectedKey,
      } as Record<string, unknown>);
      if (res.statusCode === 201) {
        expect(res.json().attachment.originalKey).not.toBe(injectedKey);
      } else {
        expect(res.statusCode).toBe(422);
      }
    });
  });

  // -------------------------------------------------------------------
  // AC-212 — complete() state machine.
  // -------------------------------------------------------------------
  describe('AC-212: complete state machine — pending → ready with HEAD verify', () => {
    /**
     * Seed a pending row and put matching bytes under its storage keys
     * so a complete() call's HEAD verification succeeds. Returns the
     * attachment id.
     */
    async function seedPendingWithBackingBytes(): Promise<string> {
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(res.statusCode).toBe(201);
      const body = res.json();
      const s = storage();
      // 120 bytes of `0xff` — arbitrary but matches sizeBytes above.
      const payload = Buffer.alloc(120_000, 0xff);
      await s.upload(body.attachment.originalKey, payload, 'image/jpeg');
      await s.upload(body.attachment.thumbKey, Buffer.from('webp-thumb'), 'image/webp');
      return body.attachment.id;
    }

    it('flips pending → ready when both objects exist and sizes match', async () => {
      const attId = await seedPendingWithBackingBytes();
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(attId);
      expect(body.status).toBe('ready');
    });

    it('returns 409 CONFLICT and leaves the row pending when the original object is missing', async () => {
      // Seed an init WITHOUT uploading bytes — the HEAD must miss.
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const attId = initRes.json().attachment.id;

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');

      // Row stays pending; the reaper is the only remover of a stuck row.
      const status = await fetchAttachmentStatus(attId);
      expect(status).toBe('pending');
    });

    it('returns 409 CONFLICT when the stored size exceeds the cap', async () => {
      // Init an attachment whose claimed size is within cap, but upload
      // an object whose actual size reports OVER cap via HEAD. The
      // spec says complete must verify the HEAD-reported size against
      // the cap (not just against the row's claimed size).
      const initRes = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        sizeBytes: 100,
      });
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();
      // Upload 2 MB under the issued key — HEAD will report it, and
      // the complete path must detect the cap breach even though the
      // row's claimed size is small.
      await s.upload(body.attachment.originalKey, Buffer.alloc(2 * 1024 * 1024, 1), 'image/jpeg');
      await s.upload(body.attachment.thumbKey, Buffer.from('t'), 'image/webp');

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    it('returns 409 CONFLICT when content-type mismatches the row', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();
      // Upload under the issued key but with a wrong content-type —
      // HEAD returns the mismatching type, complete must reject.
      await s.upload(body.attachment.originalKey, Buffer.alloc(120_000, 2), 'application/pdf');
      await s.upload(body.attachment.thumbKey, Buffer.from('t'), 'image/webp');

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    it('returns 409 CONFLICT on double-ack (complete called twice on same id)', async () => {
      const attId = await seedPendingWithBackingBytes();
      const first = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(first.statusCode).toBe(200);
      const second = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('CONFLICT');
    });

    it('returns 404 NOT_FOUND when complete is called on an id the reaper already removed', async () => {
      // Simulate a reaped row: the attachments row is removed outright.
      // Any subsequent complete call from a racing client must 404, not
      // 409 — the spec pins that distinction so clients discard the
      // pending upload state.
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const attId = initRes.json().attachment.id;

      // Direct-DB removal of the row (reaper path does this + storage delete).
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`DELETE FROM attachments WHERE id = ${attId}`);
      } finally {
        await pool.end();
      }

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------
  // AC-216 — Bulk download caps.
  // -------------------------------------------------------------------
  describe('AC-216: bulk-download caps — 20 files / 20 MB', () => {
    it('rejects a batch of 21 ids with 422 BULK_LIMIT_EXCEEDED (limits field present)', async () => {
      // We need 21 valid ready-state ids on the project for this arm;
      // building them through real uploads is slow. The server must
      // validate the COUNT before resolving ids, so 21 arbitrary uuids
      // is sufficient — the count check fires first per the spec
      // ("exceeding either cap is rejected").
      const fakeIds = Array.from({ length: 21 }, () => crypto.randomUUID());
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/bulk-download`,
        { attachmentIds: fakeIds },
      );
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.code).toBe('BULK_LIMIT_EXCEEDED');
      expect(body.details?.limits ?? body.limits).toBeDefined();
      const limits = body.details?.limits ?? body.limits;
      expect(typeof limits.maxFiles).toBe('number');
      expect(typeof limits.maxBytes).toBe('number');
    });

    it('rejects a batch whose summed sizeBytes exceeds 20 MB with BULK_LIMIT_EXCEEDED', async () => {
      // Seed three ready rows each 8 MB = 24 MB total, under the 20-file
      // cap but over the 20 MB bytes cap. Direct-DB insert because
      // uploading 24 MB three times through the real flow is wasteful
      // for a validation test — we only need the rows to exist and be
      // ready.
      const ids = await seedReadyAttachments(projectId, [
        { sizeBytes: 8 * 1024 * 1024 },
        { sizeBytes: 8 * 1024 * 1024 },
        { sizeBytes: 8 * 1024 * 1024 },
      ]);
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/bulk-download`,
        { attachmentIds: ids },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('BULK_LIMIT_EXCEEDED');
    });

    it('rejects with 422 VALIDATION_ERROR when any id belongs to a different project', async () => {
      // One id from the primary project, one from an unrelated one.
      const otherProjectId = await (async () => {
        const r = await authGet(ownerToken, '/api/projects?limit=200');
        const p = (r.json().data as { id: string; number: string }[]).find(
          (row) => row.number === `${year}-008`,
        );
        return p!.id;
      })();
      const [primaryId] = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }]);
      const [otherId] = await seedReadyAttachments(otherProjectId, [{ sizeBytes: 100 }]);
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/bulk-download`,
        { attachmentIds: [primaryId, otherId] },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects with 422 VALIDATION_ERROR when any id references a pending row', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const pendingId = initRes.json().attachment.id;

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/bulk-download`,
        { attachmentIds: [pendingId] },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 200 with a presigned URL when the batch fits the caps', async () => {
      const ids = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }, { sizeBytes: 100 }]);
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/bulk-download`,
        { attachmentIds: ids },
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.url).toBe('string');
      expect(typeof body.expiresAt).toBe('string');
    });
  });

  // -------------------------------------------------------------------
  // AC-225 — Error envelopes for upload-failure categories.
  //
  // Client behavior pivots on these codes (ui/behavior.md §9.5 +
  // ui/index.md §8.1.2 banner). Pinning them here ensures the banner
  // contract stays stable as the server evolves.
  // -------------------------------------------------------------------
  describe('AC-225: upload-failure error envelope categories', () => {
    it('unauthenticated init returns 401 UNAUTHENTICATED', async () => {
      // authPost with empty token omits the cookie; Fastify rejects at
      // the auth middleware before the route-level permission check.
      const res = await authPost(
        '',
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHENTICATED');
    });

    it('worker init on an unassigned project returns 403 NOT_PERMITTED', async () => {
      const unassignedId = await seededProjectIdUnassigned(ownerToken);
      const res = await authPost(
        workerToken,
        `/api/projects/${unassignedId}/attachments/init`,
        photoInit(unassignedId),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('init against a non-existent project id returns 404 NOT_FOUND', async () => {
      const missingId = '00000000-0000-0000-0000-00000000abcd';
      const res = await authPost(
        ownerToken,
        `/api/projects/${missingId}/attachments/init`,
        photoInit(missingId),
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('delete on a non-existent attachment id returns 404 NOT_FOUND', async () => {
      const missingId = '00000000-0000-0000-0000-00000000bbbb';
      const res = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${missingId}`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------
  // Download URL surface — validation arms.
  // (Happy-path scoping lives in attachments-scope.test.ts.)
  // -------------------------------------------------------------------
  describe('download-url — validation branches', () => {
    it('rejects an unknown variant with 422 VALIDATION_ERROR', async () => {
      const [id] = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }]);
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${id}/download-url?variant=unknown`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects thumbnail requests on a non-photo row with 422 VALIDATION_ERROR', async () => {
      const [id] = await seedReadyAttachments(projectId, [
        { sizeBytes: 100, kind: 'binary', mimeType: 'application/pdf', label: 'rechnung' },
      ]);
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${id}/download-url?variant=thumbnail`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });
  });
});

// ---------------------------------------------------------------------
// Local helpers — direct DB access so we don't couple fixture setup to
// not-yet-implemented endpoints. The attachment table ships in the
// baseline migration (src/server/db/schema.ts), so raw inserts run
// even before the service layer exists.
// ---------------------------------------------------------------------

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

interface SeedReadySpec {
  sizeBytes: number;
  kind?: 'photo' | 'binary';
  mimeType?: string;
  label?: string;
}

/**
 * Insert N `ready` attachment rows directly against the DB so the
 * bulk-download arms have predictable fixtures without going through
 * the init→complete flow. Returns the new ids in order. `__tests__/`
 * is allowlisted for AC-179's architecture check.
 */
async function seedReadyAttachments(projectId: string, specs: SeedReadySpec[]): Promise<string[]> {
  const { db, pool } = createDatabase();
  try {
    const ids: string[] = [];
    for (const spec of specs) {
      const id = crypto.randomUUID();
      const kind = spec.kind ?? 'photo';
      const mimeType = spec.mimeType ?? 'image/jpeg';
      const label = spec.label ?? 'foto';
      const originalKey = `attachments/${projectId}/${id}.orig`;
      const thumbKey = kind === 'photo' ? `attachments/${projectId}/${id}.thumb` : null;
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           original_key, thumb_key, has_thumbnail)
        VALUES (${id}, ${projectId}, 'ready', ${kind}, ${label},
                ${'file-' + id.slice(0, 6)}, ${mimeType}, ${spec.sizeBytes},
                ${originalKey}, ${thumbKey}, ${kind === 'photo'})
      `);
      ids.push(id);
    }
    return ids;
  } finally {
    await pool.end();
  }
}
