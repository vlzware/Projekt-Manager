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
 * (`startApp()` → `validateEnvRuntime()`). Direct-storage seeding uses the
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
import type { AttachmentStorageClient } from '../storage/client.js';
import { AttachmentService } from '../services/AttachmentService.js';
import type { AuthUser } from '../middleware/auth.js';
import { getEnv } from '../config/env.js';
import type { Attachment } from '../../domain/types.js';

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
      // Uploader expansion: createdBy is `{ id, displayName }` so the
      // frontend doesn't need a privileged user-directory fetch (#125).
      expect(body.attachment.createdBy).toMatchObject({
        id: expect.any(String),
        displayName: expect.any(String),
      });

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

    it('persists original + thumb version-ids on complete (ADR-0022)', async () => {
      // The bucket is versioned; every PUT (browser or test setup) yields
      // a fresh VersionId in the HEAD response. complete() captures both
      // ids and writes them to attachments.version_id / thumb_version_id
      // — the row is the sole source of truth for the future restore
      // copyFromVersion call. Pending → null; ready (with thumb) → both
      // non-null, well-formed (non-empty strings).
      const attId = await seedPendingWithBackingBytes();
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/complete`,
      );
      expect(res.statusCode).toBe(200);

      const versions = await fetchAttachmentVersions(attId);
      expect(versions).not.toBeNull();
      expect(versions?.versionId).toMatch(/.+/);
      expect(versions?.thumbVersionId).toMatch(/.+/);
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

    it('returns 404 NOT_FOUND when the project is archived between init and complete', async () => {
      // Race window: init lands on an active project, the project is
      // archived while the bytes upload, then complete tries to flip
      // pending → ready. AC-95 says mutations on archived rows must
      // not stick — without the archive guard in completeUpload, a
      // racing client could land a `ready` attachment on a frozen
      // project. The pending row remains for the reaper.
      //
      // The fixture archives the project, so it must be a fresh one —
      // archiving the shared `projectId` would poison every other arm.
      const customersRes = await authGet(ownerToken, '/api/customers');
      const customers = customersRes.json().customers ?? customersRes.json().data;
      const customerId = customers[0].id;
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: `${year}-CMP-ARCH`,
        title: 'Archive-during-upload race',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const raceProjectId = createRes.json().id;

      const initRes = await authPost(
        ownerToken,
        `/api/projects/${raceProjectId}/attachments/init`,
        photoInit(raceProjectId),
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const attId = body.attachment.id;

      // Bytes land in storage (HEAD would otherwise miss and surface 409).
      const s = storage();
      await s.upload(body.attachment.originalKey, Buffer.alloc(120_000, 0xff), 'image/jpeg');
      await s.upload(body.attachment.thumbKey, Buffer.from('webp-thumb'), 'image/webp');

      // Archive lands between init and complete.
      const archiveRes = await authDelete(ownerToken, `/api/projects/${raceProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      const completeRes = await authPost(
        ownerToken,
        `/api/projects/${raceProjectId}/attachments/${attId}/complete`,
      );
      expect(completeRes.statusCode).toBe(404);
      expect(completeRes.json().code).toBe('NOT_FOUND');

      // The pending row must survive — the reaper is the sole remover.
      const status = await fetchAttachmentStatus(attId);
      expect(status).toBe('pending');
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
  // Papierkorb — soft-hide round-trip (ADR-0022).
  //
  // Verifies the full hide→trash→restore cycle exercises the new wire:
  // delete writes status='hidden' + hiddenAt; the trash listing surfaces
  // it; restore returns it to ready with freshly-issued version-ids.
  // Permission gate (`attachment:trash`) keeps workers off the trash
  // surface entirely.
  // -------------------------------------------------------------------
  describe('Papierkorb — soft-hide round-trip', () => {
    async function seedReadyAttachment(): Promise<string> {
      const initRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        photoInit(projectId),
      );
      expect(initRes.statusCode).toBe(201);
      const body = initRes.json();
      const s = storage();
      const payload = Buffer.alloc(120_000, 0xff);
      await s.upload(body.attachment.originalKey, payload, 'image/jpeg');
      await s.upload(body.attachment.thumbKey, Buffer.from('webp-thumb'), 'image/webp');
      const completeRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(completeRes.statusCode).toBe(200);
      return body.attachment.id;
    }

    it('hide → trash → restore round-trip: status flips, version-ids re-issued', async () => {
      const attId = await seedReadyAttachment();
      const beforeVersions = await fetchAttachmentVersions(attId);
      expect(beforeVersions?.versionId).toMatch(/.+/);

      // Hide.
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}`,
      );
      expect(hideRes.statusCode).toBe(204);

      const hiddenStatus = await fetchAttachmentStatus(attId);
      expect(hiddenStatus).toBe('hidden');

      // Trash listing contains the row, with hiddenAt populated.
      const trashRes = await authGet(ownerToken, `/api/projects/${projectId}/attachments/trash`);
      expect(trashRes.statusCode).toBe(200);
      const trashBody = trashRes.json() as { data: Attachment[] };
      const found = trashBody.data.find((it) => it.id === attId);
      expect(found).toBeDefined();
      expect(found!.status).toBe('hidden');
      expect(found!.hiddenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Live list excludes it.
      const listRes = await authGet(ownerToken, `/api/projects/${projectId}/attachments`);
      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json() as { data: Attachment[] };
      expect(listBody.data.some((it) => it.id === attId)).toBe(false);

      // Restore.
      const restoreRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(restoreRes.statusCode).toBe(200);
      const restored = restoreRes.json() as Attachment;
      expect(restored.status).toBe('ready');
      expect(restored.hiddenAt).toBeNull();

      // Fresh version-ids — copyFromVersion produced new current versions.
      const afterVersions = await fetchAttachmentVersions(attId);
      expect(afterVersions?.versionId).toMatch(/.+/);
      // The new ones may equal the old ones only if the bucket is
      // unversioned (test mis-config); on a versioned bucket every PUT
      // produces a fresh id, including the server-side copy.
      expect(afterVersions?.versionId).not.toBe(beforeVersions?.versionId);

      // Trash listing no longer carries it.
      const trashAfter = await authGet(ownerToken, `/api/projects/${projectId}/attachments/trash`);
      expect((trashAfter.json() as { data: Attachment[] }).data.some((it) => it.id === attId)).toBe(
        false,
      );
    });

    it('restore on a ready row returns 409 CONFLICT (idempotent guard)', async () => {
      const attId = await seedReadyAttachment();
      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    // -----------------------------------------------------------------
    // CAS-loss atomicity (issue #45 H1). Two concurrent restores on the
    // same hidden row: one must succeed (200, 'ready'), one must lose
    // the CAS (409). After the dust settles, the row's persisted
    // version_id MUST equal storage's actual current version — i.e. the
    // failed restore must NOT have produced an orphan current version.
    //
    // This pins the atomicity invariant: storage advances ONLY when the
    // DB CAS commits. A regression that runs copyFromVersion before the
    // CAS would leave the bucket's current version pointing at the
    // loser's copy while the DB version_id reflects the winner's — a
    // silent storage/DB drift that tests on the happy path can't catch.
    // -----------------------------------------------------------------
    it('two concurrent restores: one wins, one loses CAS, storage and DB stay consistent', async () => {
      const attId = await seedReadyAttachment();

      // Hide the row first so both concurrent calls hit the restore path.
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}`,
      );
      expect(hideRes.statusCode).toBe(204);

      // Read the keys so we can probe storage afterward.
      const keys = await fetchAttachmentKeys(attId);
      expect(keys).not.toBeNull();

      // Fire both restores in parallel. Postgres will serialize the
      // CAS UPDATEs at the row-level lock acquired by the first to
      // reach `markRestored`; the second blocks, then finds status
      // already flipped to 'ready' and returns null (CAS-loss).
      const [r1, r2] = await Promise.all([
        authPost(ownerToken, `/api/projects/${projectId}/attachments/${attId}/restore`),
        authPost(ownerToken, `/api/projects/${projectId}/attachments/${attId}/restore`),
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 409]);

      // Storage's actual current version of the original key —
      // determined by HEAD, which reports the bucket's current
      // VersionId. With the atomicity fix, exactly one copyFromVersion
      // ran (the winner's), so this version_id is the winner's.
      const s = storage();
      const head = await s.headObject(keys!.originalKey);

      // The DB's persisted version_id must match storage. Mismatch ⇒
      // an orphan current version exists from the failed restore =>
      // C-DATA invariant violated.
      const dbVersions = await fetchAttachmentVersions(attId);
      expect(dbVersions?.versionId).toBe(head.versionId);
    });

    it('worker is rejected from the trash listing with 403 NOT_PERMITTED', async () => {
      const res = await authGet(workerToken, `/api/projects/${projectId}/attachments/trash`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker is rejected from restore with 403 NOT_PERMITTED', async () => {
      const attId = await seedReadyAttachment();
      const res = await authPost(
        workerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    // -----------------------------------------------------------------
    // Restore — error-semantic distinctions (issue #45 H5).
    //
    // 422 (data integrity, structurally unrestorable) vs 409 (transient
    // race, retry resolves) carries operator meaning: an operator
    // fielding 422 inspects the row; an operator fielding 409 retries.
    // Reusing 409 for both — as the original implementation did — buries
    // the integrity case under the noise of routine race conflicts.
    // -----------------------------------------------------------------
    it('returns 422 VALIDATION_ERROR when a hidden row has no version_id (data integrity)', async () => {
      // Seed a hidden row directly with version_id=NULL — simulates a
      // pre-#45 hide (or any future regression that drops the version
      // capture). Restore must surface this as 422, not 409: 409 says
      // "retry" and the row will not become restorable on retry.
      const attId = await seedHiddenAttachment(projectId, {
        versionId: null,
        thumbVersionId: null,
        hasThumbnail: false,
      });

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      // The operator-visible message names the row id so the activity
      // feed entry is actionable without spelunking the DB.
      expect(res.json().message).toContain(attId);
    });

    it('returns 422 VALIDATION_ERROR when hasThumbnail=true and thumb_version_id is null', async () => {
      // Seed a hidden photo row with version_id set but
      // thumb_version_id null. Without the integrity check, the service
      // would silently restore only the original and the gallery
      // preview would be permanently lost.
      const attId = await seedHiddenAttachment(projectId, {
        versionId: 'fake-original-version-id',
        thumbVersionId: null,
        hasThumbnail: true,
      });

      const res = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}/restore`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      // Distinct message from the original-side branch — names the
      // affected row id and identifies the missing field.
      const body = res.json();
      expect(body.message).toContain(attId);
      expect(body.message).toContain('thumb_version_id');
    });

    // -----------------------------------------------------------------
    // Restore on archived projects (issue #45 Medium).
    //
    // Asymmetry by design: hide on archived stays forbidden (read-only
    // preview), restore on archived is permitted. Without the latter,
    // binaries in an archived project's trash would silently reap after
    // L days with no recovery path; archive is a reversible state,
    // destruction by lifecycle is not.
    //
    // Three arms:
    //   1. Restore against an archived project succeeds.
    //   2. Hide against an archived project still rejects (regression
    //      guard for the archive read-only invariant).
    //   3. The Papierkorb listing is callable on an archived project so
    //      the user can SEE what's recoverable.
    // -----------------------------------------------------------------
    it('restore on an archived project succeeds (hide is irreversible by lifecycle)', async () => {
      // Seed: ready attachment → hide → archive the project. Restore
      // must still succeed; without it, lifecycle would silently reap.
      const attId = await seedReadyAttachment();
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${projectId}/attachments/${attId}`,
      );
      expect(hideRes.statusCode).toBe(204);

      // Archive on a fresh project so we don't poison the shared one.
      // Move the (already-hidden) attachment over by re-uploading on a
      // new project, then archiving — simpler to spin a fresh one with
      // its own hidden row.
      const customersRes = await authGet(ownerToken, '/api/customers');
      const customers = customersRes.json().customers ?? customersRes.json().data;
      const customerId = customers[0].id;
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: `${year}-REST-ARCH`,
        title: 'Restore-on-archived',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const archProjectId = createRes.json().id;

      // Seed a hidden row directly on the soon-to-be-archived project
      // so we don't depend on the upload pipeline's archive race.
      // version_id matches a real storage version we put in the bucket.
      const archAttId = crypto.randomUUID();
      const originalKey = `attachments/${archProjectId}/${archAttId}.orig`;
      const s = storage();
      const putRes = await s.upload(originalKey, Buffer.from('arch-bytes'), 'application/pdf');
      expect(putRes).toBeDefined();
      // Read back the version-id of what we just put — this becomes the
      // source for copyFromVersion.
      const head = await s.headObject(originalKey);
      expect(head.versionId).toBeDefined();
      const { db, pool } = createDatabase();
      try {
        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             original_key, thumb_key, has_thumbnail,
             version_id, thumb_version_id, hidden_at)
          VALUES (${archAttId}, ${archProjectId}, 'hidden', 'binary', 'sonstiges',
                  'arch-doc.pdf', 'application/pdf', 10,
                  ${originalKey}, NULL, FALSE,
                  ${head.versionId!}, NULL, NOW())
        `);
      } finally {
        await pool.end();
      }

      // Archive the project.
      const archiveRes = await authDelete(ownerToken, `/api/projects/${archProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      // Restore must succeed despite archival — that's the whole point.
      const restoreRes = await authPost(
        ownerToken,
        `/api/projects/${archProjectId}/attachments/${archAttId}/restore`,
      );
      expect(restoreRes.statusCode).toBe(200);
      const restored = restoreRes.json() as Attachment;
      expect(restored.status).toBe('ready');
      expect(restored.hiddenAt).toBeNull();

      // Cleanup: avoid leaving the archived project hanging — leave the
      // shared `projectId` arm green. (The archived project itself can
      // stay; subsequent tests don't care.)
      void attId; // marker — unused in this arm
    });

    it('hide on an archived project is rejected (read-only preview invariant)', async () => {
      // Regression guard for the archive read-only contract. The
      // restore-on-archived fix must NOT have lifted the hide-side
      // gate.
      const customersRes = await authGet(ownerToken, '/api/customers');
      const customers = customersRes.json().customers ?? customersRes.json().data;
      const customerId = customers[0].id;
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: `${year}-HIDE-ARCH`,
        title: 'Hide-on-archived rejected',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const archProjectId = createRes.json().id;

      // Seed a ready row on the project, then archive.
      const [hideAttId] = await seedReadyAttachments(archProjectId, [{ sizeBytes: 100 }]);
      const archiveRes = await authDelete(ownerToken, `/api/projects/${archProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      // Hide must reject — the gate stays.
      const hideRes = await authDelete(
        ownerToken,
        `/api/projects/${archProjectId}/attachments/${hideAttId}`,
      );
      expect(hideRes.statusCode).toBe(404);
      expect(hideRes.json().code).toBe('NOT_FOUND');
    });

    it('Papierkorb listing is callable on an archived project (user must see what is recoverable)', async () => {
      // The user must be able to inspect the archived project's trash
      // before deciding to restore. This pairs with the restore-on-
      // archived behaviour — listing without restore would be a
      // useless cul-de-sac.
      const customersRes = await authGet(ownerToken, '/api/customers');
      const customers = customersRes.json().customers ?? customersRes.json().data;
      const customerId = customers[0].id;
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: `${year}-LIST-ARCH`,
        title: 'List-archived-trash',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const archProjectId = createRes.json().id;

      // Seed one hidden row so the listing has something visible.
      const archAttId = await seedHiddenAttachment(archProjectId, {
        versionId: 'fake-vid',
        thumbVersionId: null,
        hasThumbnail: false,
      });

      const archiveRes = await authDelete(ownerToken, `/api/projects/${archProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      const trashRes = await authGet(
        ownerToken,
        `/api/projects/${archProjectId}/attachments/trash`,
      );
      expect(trashRes.statusCode).toBe(200);
      const body = trashRes.json() as { data: Attachment[] };
      expect(body.data.some((it) => it.id === archAttId)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Hide — storage-first atomicity.
  //
  // The atomicity contract: storage hide runs BEFORE the DB CAS. A
  // storage failure throws, the DB row stays in `ready`, and no
  // `attachment:hide` audit row is written. The user retries; storage
  // hide is idempotent (S3 DeleteObject without VersionId on a
  // versioned bucket).
  //
  // The earlier (broken) shape ran storage AFTER the CAS commit and
  // swallowed errors — a storage outage left a `hidden` row whose
  // backing object was still the bucket's CURRENT version. The
  // bucket lifecycle reaps NONCURRENT versions only, so the file
  // would persist indefinitely with no UI affordance to retry.
  //
  // This block bypasses the route layer and constructs `AttachmentService`
  // directly so a flaky storage proxy can inject the failure.
  // -------------------------------------------------------------------
  describe('Hide — storage-first atomicity', () => {
    it('storage.hide failure leaves the row in ready, writes no audit row, and surfaces the error', async () => {
      // Seed one ready row directly. The seeded row has no real
      // backing bytes, but the contract under test never reaches
      // storage successfully — the proxy throws on the first call.
      const [attId] = await seedReadyAttachments(projectId, [{ sizeBytes: 100 }]);

      // Resolve the owner user id from the same DB the service will
      // see — the service expects a real user id for the audit
      // actor, even though no audit row should be written here.
      const { db, pool } = createDatabase();
      let ownerId: string;
      try {
        const res = await db.execute(
          sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
        );
        const row = res.rows[0] as { id: string } | undefined;
        if (!row) throw new Error('owner user missing from seed');
        ownerId = row.id;
      } finally {
        await pool.end();
      }

      // Audit-row count snapshot — under the new contract a storage
      // failure must produce no audit row at all.
      const auditBefore = await countAuditRows();

      // Build a storage proxy that throws on `hide` but delegates
      // every other call. Mirrors the proxy pattern used in
      // attachments-bulk-download-reaper.test.ts.
      const realStorage = storage();
      const flakyStorage: AttachmentStorageClient = {
        ...realStorage,
        hide: async () => {
          throw new Error('simulated-storage-flake');
        },
      };

      // Construct the service with the flaky storage; reuse the
      // app's DB. We bypass the route layer because the live route
      // wiring uses the real storage client.
      const { db: serviceDb, pool: servicePool } = createDatabase();
      try {
        const service = new AttachmentService({ db: serviceDb, storage: flakyStorage });
        const owner: AuthUser = {
          id: ownerId,
          username: SEED_USERS.owner.username,
          displayName: SEED_USERS.owner.displayName,
          roles: [...SEED_USERS.owner.roles],
          email: null,
          themePreference: 'system',
          pushMuted: false,
        };
        const noopLog = { info: () => {}, error: () => {} };

        await expect(
          service.hideAttachment(owner, projectId, attId, noopLog, null),
        ).rejects.toThrow('simulated-storage-flake');
      } finally {
        await servicePool.end();
      }

      // Row stays in `ready` — no DB CAS happened.
      const status = await fetchAttachmentStatus(attId);
      expect(status).toBe('ready');

      // No audit row was written.
      const auditAfter = await countAuditRows();
      expect(auditAfter).toBe(auditBefore);
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

async function countAuditRows(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

async function fetchAttachmentKeys(
  id: string,
): Promise<{ originalKey: string; thumbKey: string | null } | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT original_key, thumb_key FROM attachments WHERE id = ${id} LIMIT 1`,
    );
    const row = res.rows[0] as { original_key: string; thumb_key: string | null } | undefined;
    if (!row) return null;
    return { originalKey: row.original_key, thumbKey: row.thumb_key };
  } finally {
    await pool.end();
  }
}

async function fetchAttachmentVersions(
  id: string,
): Promise<{ versionId: string | null; thumbVersionId: string | null } | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT version_id, thumb_version_id FROM attachments WHERE id = ${id} LIMIT 1`,
    );
    const row = res.rows[0] as
      | { version_id: string | null; thumb_version_id: string | null }
      | undefined;
    if (!row) return null;
    return { versionId: row.version_id, thumbVersionId: row.thumb_version_id };
  } finally {
    await pool.end();
  }
}

/**
 * Insert one row directly in `hidden` state with explicit version_id
 * shape so the integrity-error arms (issue #45 H5) can exercise the
 * unrestorable-row branches. The route-driven path always commits
 * non-null version_ids on a #45-era hide, so DB-level seeding is the
 * only way to land the regression shape these tests pin.
 */
async function seedHiddenAttachment(
  projectId: string,
  spec: { versionId: string | null; thumbVersionId: string | null; hasThumbnail: boolean },
): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const kind = spec.hasThumbnail ? 'photo' : 'binary';
    const label = spec.hasThumbnail ? 'foto' : 'sonstiges';
    const mimeType = spec.hasThumbnail ? 'image/jpeg' : 'application/pdf';
    const filename = `hidden-${id.slice(0, 6)}.${spec.hasThumbnail ? 'jpg' : 'pdf'}`;
    const originalKey = `attachments/${projectId}/${id}.orig`;
    const thumbKey = spec.hasThumbnail ? `attachments/${projectId}/${id}.thumb` : null;
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         original_key, thumb_key, has_thumbnail,
         version_id, thumb_version_id, hidden_at)
      VALUES (${id}, ${projectId}, 'hidden', ${kind}, ${label},
              ${filename}, ${mimeType}, 100,
              ${originalKey}, ${thumbKey}, ${spec.hasThumbnail},
              ${spec.versionId}, ${spec.thumbVersionId}, NOW())
    `);
    return id;
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
