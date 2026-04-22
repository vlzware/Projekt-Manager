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

    it('returns 409 CONFLICT when the stored size differs from the declared sizeBytes', async () => {
      // AC-212 / spec §14.2.11 error paths: complete verifies the
      // HEAD-reported size against the row's DECLARED size, not just the
      // global cap. A size-substitution upload — e.g. 2 MB bytes under
      // a key whose row claims 100 B — must land as 409 even if the
      // actual size is within the global cap.
      const initRes = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...photoInit(projectId),
        sizeBytes: 100,
      });
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();
      // Upload 2 MB under the issued key (note: the presigned POST
      // policy would reject this via `content-length-range`; we bypass
      // that by direct-storage upload to exercise the complete-side
      // guard). HEAD reports 2 MB, row says 100 → declared-size
      // mismatch → 409.
      await s.upload(body.attachment.originalKey, Buffer.alloc(2 * 1024 * 1024, 1), 'image/jpeg');
      await s.upload(body.attachment.thumbKey, Buffer.from('t'), 'image/webp');

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    it('returns 409 CONFLICT when the stored size matches the row but exceeds the global cap (defence in depth)', async () => {
      // Normal init rejects sizeBytes > cap up-front, so this branch is
      // only reachable if the cap dropped between init and complete.
      // Seed a pending row directly with an over-cap `size_bytes`
      // matching the bytes we'll upload, then call complete() — the
      // global-cap guard (in addition to the declared-size guard) must
      // fire.
      const attId = crypto.randomUUID();
      const originalKey = `attachments/${projectId}/${attId}.orig`;
      const thumbKey = `attachments/${projectId}/${attId}.thumb`;
      const oversize = 2 * 1024 * 1024;
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             original_key, thumb_key, has_thumbnail)
          VALUES (${attId}, ${projectId}, 'pending', 'photo', 'foto',
                  'oversize.jpg', 'image/jpeg', ${oversize},
                  ${originalKey}, ${thumbKey}, TRUE)
        `);
      } finally {
        await pool.end();
      }
      const s = storage();
      await s.upload(originalKey, Buffer.alloc(oversize, 3), 'image/jpeg');
      await s.upload(thumbKey, Buffer.from('t'), 'image/webp');

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
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

    it('returns 200 with a presigned URL that resolves to a real zip containing the requested entries', async () => {
      // Real bytes behind the two ready rows so archiver has something
      // to stream. Filenames chosen to exercise the no-collision path;
      // the duplicate-filename disambiguation is covered by the next arm.
      // Content-type is whitelisted (`application/pdf`) because the
      // attachments table has a CHECK constraint on mime_type — the
      // happy-path row must satisfy it.
      const bytesA = Buffer.from('alpha-contents-alpha-contents-alpha', 'utf-8');
      const bytesB = Buffer.from('bravo-1234-bravo-1234-bravo-1234', 'utf-8');
      const ids = await seedReadyAttachmentsWithBytes(projectId, [
        { bytes: bytesA, filename: 'alpha.pdf', mimeType: 'application/pdf' },
        { bytes: bytesB, filename: 'bravo.pdf', mimeType: 'application/pdf' },
      ]);
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/bulk-download`,
        { attachmentIds: ids },
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.url).toBe('string');
      expect(typeof body.expiresAt).toBe('string');

      // Follow the presigned URL — the whole point of AC-221 is that the
      // bytes do not transit the app. The URL must resolve to a real
      // zip whose entries match the requested filenames.
      const zipBuffer = await fetchBytesFromUrl(body.url);
      const entries = await listZipEntries(zipBuffer);
      expect(entries).toContain('alpha.pdf');
      expect(entries).toContain('bravo.pdf');
      expect(entries).toHaveLength(2);
    });

    it('disambiguates duplicate filenames within a single zip', async () => {
      // Two rows sharing `doc.pdf` — archiver would otherwise emit two
      // identically-named entries, which Windows Explorer + many zip
      // viewers refuse to open. The service appends a short-id suffix
      // before the extension.
      const ids = await seedReadyAttachmentsWithBytes(projectId, [
        { bytes: Buffer.from('first-copy'), filename: 'doc.pdf', mimeType: 'application/pdf' },
        { bytes: Buffer.from('second-copy'), filename: 'doc.pdf', mimeType: 'application/pdf' },
      ]);
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/bulk-download`,
        { attachmentIds: ids },
      );
      expect(res.statusCode).toBe(200);
      const zipBuffer = await fetchBytesFromUrl(res.json().url);
      const entries = await listZipEntries(zipBuffer);
      expect(entries).toHaveLength(2);
      expect(entries).toContain('doc.pdf');
      // The second copy is renamed with a short-id suffix: ` (xxxxxxxx).pdf`.
      expect(entries.some((n) => /doc \([0-9a-f]{8}\)\.pdf/.test(n))).toBe(true);
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

    // -----------------------------------------------------------------
    // Pending-row invisibility (review H6). `listByProject` only
    // surfaces ready rows; `issueDownloadUrl` must mirror that, or a
    // caller could fetch a presigned GET for partially-uploaded bytes
    // before the HEAD-verify gate ran. 404 matches the reaper-removed
    // branch from the caller's point of view.
    // -----------------------------------------------------------------
    it('returns 404 NOT_FOUND when variant=original and the row is pending', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const pendingId = initRes.json().attachment.id;
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${pendingId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND when variant=thumbnail and the row is pending', async () => {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const pendingId = initRes.json().attachment.id;
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${pendingId}/download-url?variant=thumbnail`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------
  // Filename validation + Content-Disposition — review of Fix 4.
  //
  // The service-boundary validator rejects control chars + path
  // separators so malicious bytes never land in the DB. The
  // Content-Disposition header is the second line of defence: even if
  // something bypassed the validator, header injection is prevented by
  // the ASCII-fallback sanitize and the UTF-8 extended form keeps
  // non-ASCII filenames (German umlauts, the common case) legible.
  // -------------------------------------------------------------------
  describe('Filename validation + Content-Disposition encoding', () => {
    it.each([
      ['CR', 'evil\r.pdf'],
      ['LF', 'evil\n.pdf'],
      ['null', 'evil\x00.pdf'],
      ['forward slash', 'evil/path.pdf'],
      ['backslash', 'evil\\path.pdf'],
    ])('rejects fileName containing %s with 422 VALIDATION_ERROR', async (_label, fileName) => {
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'sonstiges',
        hasThumbnail: false,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('accepts non-ASCII filenames and emits an RFC 5987 Content-Disposition on download', async () => {
      // German umlauts are the common case — any sanitizer that strips
      // them here would break half the customer's filenames. Init
      // must accept the name, complete must preserve it, and the
      // download-url's presigned GET must carry a `filename*=UTF-8''`
      // parameter (or at minimum the percent-encoded bytes) so the
      // browser's Save-As dialog shows the original characters.
      //
      // S3 presigned URLs deliver the disposition via the
      // `response-content-disposition` query param, which the signer
      // percent-encodes once on its own. A single `decodeURIComponent`
      // therefore yields the disposition we built — further characters
      // in the disposition's UTF-8 form (e.g. `%C3%BC`) stay encoded
      // because they belong to the header body, not the URL envelope.
      const umlautName = 'Angebot Müller.pdf';
      const bytes = Buffer.from('test-bytes', 'utf-8');
      const ids = await seedReadyAttachmentsWithBytes(projectId, [
        { bytes, filename: umlautName, mimeType: 'application/pdf' },
      ]);
      const res = await authGet(
        ownerToken,
        `/api/projects/${projectId}/attachments/${ids[0]}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(200);
      const url = res.json().url as string;
      // The disposition value itself — after one round of URL decoding —
      // must carry the RFC 5987 extended parameter so browsers pick up
      // the non-ASCII characters.
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain("filename*=UTF-8''");
      // The UTF-8 bytes of `ü` (U+00FC) are `0xC3 0xBC`. Because
      // `encodeURIComponent('ü')` produces `%C3%BC`, and the URL
      // envelope then encodes each `%` as `%25`, the raw URL contains
      // `%25C3%25BC` (percent-of-percent). The once-decoded string
      // reveals the original `%C3%BC` form.
      expect(decoded).toContain('%C3%BC');
    });

    it('accepts a non-ASCII filename at init and round-trips it to the row', async () => {
      // Only control chars + path separators are rejected; German
      // umlauts are legitimate input and must survive init unchanged.
      // Complete() would need backing bytes to flip to ready, which is
      // out of scope for this arm — the download-side Content-Disposition
      // assertion is covered by the previous test via
      // `seedReadyAttachmentsWithBytes`.
      const initRes = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        fileName: 'Angebot Müller.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        label: 'angebot',
        hasThumbnail: false,
      });
      expect(initRes.statusCode).toBe(201);
      expect(initRes.json().attachment.fileName).toBe('Angebot Müller.pdf');
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

interface SeedReadyWithBytesSpec {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  kind?: 'photo' | 'binary';
  label?: string;
}

/**
 * Seed `ready` rows AND upload the backing bytes to storage. Used by
 * the bulk-download happy-path arm which follows the presigned URL and
 * verifies the resulting zip's contents — a no-bytes seed can pass the
 * DB validation but the archiver would stream nothing.
 *
 * Extends `seedReadyAttachments` rather than replacing it because most
 * bulk-download arms do not need real bytes (cap-breach, cross-project,
 * pending-in-batch all short-circuit before storage is touched).
 */
async function seedReadyAttachmentsWithBytes(
  projectId: string,
  specs: SeedReadyWithBytesSpec[],
): Promise<string[]> {
  const { db, pool } = createDatabase();
  const s = storage();
  try {
    const ids: string[] = [];
    for (const spec of specs) {
      const id = crypto.randomUUID();
      const kind = spec.kind ?? 'binary';
      const label = spec.label ?? 'sonstiges';
      const originalKey = `attachments/${projectId}/${id}.orig`;
      const thumbKey = kind === 'photo' ? `attachments/${projectId}/${id}.thumb` : null;
      await s.upload(originalKey, spec.bytes, spec.mimeType);
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           original_key, thumb_key, has_thumbnail)
        VALUES (${id}, ${projectId}, 'ready', ${kind}, ${label},
                ${spec.filename}, ${spec.mimeType}, ${spec.bytes.length},
                ${originalKey}, ${thumbKey}, ${kind === 'photo'})
      `);
      ids.push(id);
    }
    return ids;
  } finally {
    await pool.end();
  }
}

/**
 * Download bytes from a URL. Used to verify the presigned-GET URL
 * resolves to a real zip — the whole point of AC-221 is that the bytes
 * flow direct from storage to client without transiting the app.
 */
async function fetchBytesFromUrl(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText} — ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * List the entry names in a zip buffer. Parses the end-of-central-
 * directory record and the central directory itself, reading only
 * filenames — we do not need entry contents for these assertions.
 *
 * Zero external dependencies: the test file already imports
 * `archiver` only indirectly (via the service); pulling in `yauzl` or
 * `adm-zip` just to list entries would add a test-only dep for two
 * assertions. The parser is ~40 lines and only reads well-defined
 * fixed offsets from the zip spec (APPNOTE.TXT §4.4).
 */
async function listZipEntries(zip: Buffer): Promise<string[]> {
  // End of central directory record signature: 0x06054b50, located in
  // the last 22 bytes (or last 22 + comment bytes; comments rare).
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Not a zip buffer: EOCD record not found');
  const cdSize = zip.readUInt32LE(eocdOffset + 12);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);

  const entries: string[] = [];
  let cursor = cdOffset;
  const end = cdOffset + cdSize;
  while (cursor < end) {
    if (zip.readUInt32LE(cursor) !== CD_SIG) break;
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf-8');
    entries.push(name);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
