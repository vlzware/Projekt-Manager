/**
 * API integration tests — binary-descriptors surface (AC-248).
 *
 * Pins the wire contract for the export-all companion endpoint
 *
 *   GET /api/export/binary-descriptors?after=<cursor>&limit=<n>
 *
 * defined in api.md §14.2.4 ("Binary descriptors") and verification.md
 * AC-248. Written ahead of implementation: until the route exists every
 * arm fails with HTTP 404 — never with a TypeScript compile error.
 *
 * AC coverage in this file:
 *   - AC-248: permission gate (owner / office 200, worker / bookkeeper
 *             403, unauthenticated 401), pagination semantics
 *             (ascending `(createdAt, id)` cursor, no-cursor first
 *             page, `nextCursor=null` terminator, late insert lands
 *             after the cursor), `BinaryDescriptor` payload shape
 *             (every documented field; fetch triple OR
 *             `error = 'DEK_UNWRAP_FAILED'` discriminator; 32-byte DEK
 *             after base64-decode; matches the freshly-unwrapped
 *             `wrappedDek`), `totalCount` / `totalSizeBytes` server-
 *             computed at first-page composition and stable across
 *             pages, scope filter (`pending` and `hidden` excluded),
 *             unscoped surface (owner / office see every row), no-audit
 *             parity with `Export`, per-row `DEK_UNWRAP_FAILED` inline
 *             surfacing (no page-level 500), error paths (malformed
 *             cursor → 422, out-of-bounds limit → 422, wholesale
 *             unwrap failure → 500).
 *
 * Mirrors the dense `attachments-routes.test.ts` style for AC-216 — same
 * harness (`startApp` / per-role tokens), same direct-DB seeding helpers
 * (`seedReadyAttachments`, real `wrapFreshDek` envelopes), same audit-
 * row delta assertion (`countAuditRows`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startApp, stopApp, login, authGet } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';

const year = new Date().getFullYear();

// ---------------------------------------------------------------
// `[C]` — Export-all per-page descriptor limit (architecture.md §12.2):
// default 100, ceiling 500. The 422 arm asserts the boundary — the
// validator must reject `limit > 500`, and a request below the floor
// (≤ 0) should likewise reject.
// ---------------------------------------------------------------
const PER_PAGE_DEFAULT = 100;
const PER_PAGE_CEILING = 500;

/**
 * Wrap a fresh 32-byte DEK against the per-fork test binary identity.
 * Returns `{ dek, wrappedBase64 }` so the AC-248 "originalDekMaterial
 * matches the freshly-unwrapped wrappedDek" arm has both halves.
 *
 * Mirrors the helper of the same name in `attachments-routes.test.ts`.
 * Reads `process.env` directly because the env zod schema does not yet
 * carry the `BINARY_AGE_*` keys via `getEnv()` — tracked debt; once the
 * schema lands this collapses.
 */
async function wrapFreshDek(): Promise<{ dek: Buffer; wrappedBase64: string }> {
  const recipient = process.env.BINARY_AGE_RECIPIENT;
  const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
  if (!recipient || !identityPath) {
    throw new Error(
      'wrapFreshDek: BINARY_AGE_RECIPIENT / BINARY_AGE_IDENTITY_PATH not configured. ' +
        'Per-fork identity is set in src/test/integration-setup.ts.',
    );
  }
  const identity = readFileSync(identityPath, 'utf-8').trim();
  const service = new KeyEnvelopeService({ recipient, identity });
  const dek = crypto.randomBytes(32);
  const envelope = await service.wrap(dek);
  return { dek, wrappedBase64: Buffer.from(envelope).toString('base64') };
}

interface SeedReadySpec {
  sizeBytes: number;
  kind?: 'photo' | 'binary';
  mimeType?: string;
  label?: string;
  fileName?: string;
  /** Optional override of `created_at` so iteration-order tests can pin specific timestamps. */
  createdAt?: Date;
}

/**
 * Insert N `ready` attachment rows directly against the DB. Returns the
 * new ids in order. Each row carries a real `wrapped_dek` so the
 * descriptor route's per-row unwrap succeeds and the AC-248 byte-equality
 * arm has a real envelope to compare against.
 *
 * `createdAt` override threads through the SQL so tests that need a
 * specific `(createdAt, id)` ordering pin the value rather than relying
 * on insert order.
 */
async function seedReadyAttachments(
  projectId: string,
  specs: SeedReadySpec[],
): Promise<Array<{ id: string; dek: Buffer }>> {
  const { db, pool } = createDatabase();
  try {
    const out: Array<{ id: string; dek: Buffer }> = [];
    for (const spec of specs) {
      const id = crypto.randomUUID();
      const kind = spec.kind ?? 'binary';
      const mimeType = spec.mimeType ?? 'application/pdf';
      const label = spec.label ?? 'sonstiges';
      const filename = spec.fileName ?? `file-${id.slice(0, 6)}.pdf`;
      const originalKey = `attachments/${projectId}/${id}.orig`;
      const thumbKey = kind === 'photo' ? `attachments/${projectId}/${id}.thumb` : null;
      const ciphertextSize = spec.sizeBytes + 64;
      const ciphertextThumbSize =
        kind === 'photo' ? Math.max(64, Math.floor(ciphertextSize / 10)) : null;
      const orig = await wrapFreshDek();
      const thumb = kind === 'photo' ? await wrapFreshDek() : null;
      const createdAtIso = spec.createdAt ? spec.createdAt.toISOString() : null;
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes, ciphertext_thumb_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version,
           created_at)
        VALUES (${id}, ${projectId}, 'ready', ${kind}, ${label},
                ${filename}, ${mimeType}, ${spec.sizeBytes},
                ${ciphertextSize}, ${ciphertextThumbSize},
                ${originalKey}, ${thumbKey}, ${kind === 'photo'},
                ${orig.wrappedBase64}, ${thumb?.wrappedBase64 ?? null}, 1,
                ${createdAtIso ?? sql`NOW()`})
      `);
      out.push({ id, dek: orig.dek });
    }
    return out;
  } finally {
    await pool.end();
  }
}

/** Insert one `pending` row — must be excluded from descriptor enumeration. */
async function seedPendingAttachment(projectId: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const originalKey = `attachments/${projectId}/${id}.orig`;
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         original_key, has_thumbnail, wrapped_dek_version)
      VALUES (${id}, ${projectId}, 'pending', 'binary', 'sonstiges',
              ${`pending-${id.slice(0, 6)}.pdf`}, 'application/pdf', 100,
              ${originalKey}, FALSE, 1)
    `);
    return id;
  } finally {
    await pool.end();
  }
}

/** Insert one `hidden` row — must be excluded from descriptor enumeration. */
async function seedHiddenAttachment(projectId: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const originalKey = `attachments/${projectId}/${id}.orig`;
    const wrapped = Buffer.alloc(192, 0x33).toString('base64');
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes,
         original_key, has_thumbnail,
         wrapped_dek, wrapped_dek_version,
         hidden_at)
      VALUES (${id}, ${projectId}, 'hidden', 'binary', 'sonstiges',
              ${`hidden-${id.slice(0, 6)}.pdf`}, 'application/pdf', 100,
              164,
              ${originalKey}, FALSE,
              ${wrapped}, 1,
              NOW())
    `);
    return id;
  } finally {
    await pool.end();
  }
}

/**
 * Insert one `ready` row whose `wrapped_dek` is structurally invalid
 * (random bytes, not a real `age` envelope). The route's per-row
 * unwrap must fail on this row — the spec says surface inline as
 * `error = 'DEK_UNWRAP_FAILED'` with the fetch triple omitted, NOT a
 * page-level 500.
 */
async function seedReadyWithCorruptEnvelope(projectId: string, fileName: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const originalKey = `attachments/${projectId}/${id}.orig`;
    const corrupted = Buffer.from(
      'this-is-not-a-valid-age-envelope-' + crypto.randomUUID(),
    ).toString('base64');
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes,
         original_key, has_thumbnail,
         wrapped_dek, wrapped_dek_version)
      VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
              ${fileName}, 'application/pdf', 100,
              164,
              ${originalKey}, FALSE,
              ${corrupted}, 1)
    `);
    return id;
  } finally {
    await pool.end();
  }
}

/** Total `audit_log` row count — used for the no-audit assertion. */
async function countAuditRows(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

/** Wipe every `attachments` row so each describe block starts from a clean iteration set. */
async function wipeAttachments(): Promise<void> {
  const { db, pool } = createDatabase();
  try {
    await db.execute(sql`DELETE FROM attachments`);
  } finally {
    await pool.end();
  }
}

async function projectIdByNumber(ownerToken: string, suffix: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (row) => row.number === `${year}-${suffix}`,
  );
  if (!p) throw new Error(`seed missing ${year}-${suffix}`);
  return p.id;
}

/**
 * Documented `BinaryDescriptor` shape — pulled directly from
 * api.md §14.2.4 + verification.md AC-248. Used as the assertion target
 * for the payload-shape arm.
 */
interface BinaryDescriptor {
  attachmentId: string;
  projectId: string;
  projectNumber: string;
  projectTitle: string;
  fileName: string;
  sizeBytes: number;
  originalUrl?: string;
  originalDekMaterial?: string;
  expiresAt?: string;
  error?: 'DEK_UNWRAP_FAILED';
}

interface DescriptorPage {
  entries: BinaryDescriptor[];
  nextCursor: string | null;
  totalCount: number;
  totalSizeBytes: number;
}

describe('AC-248: binary-descriptors contract', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;
  let projectAId: string; // a worker-assigned project (year-007 per seed)
  let projectBId: string; // a worker-unassigned project (year-001 per seed)

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
    bookkeeperToken = await login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD);
    projectAId = await projectIdByNumber(ownerToken, '007');
    projectBId = await projectIdByNumber(ownerToken, '001');
  });

  afterAll(async () => {
    await wipeAttachments();
    await stopApp();
  });

  // -------------------------------------------------------------------
  // Permission gate — `data:export` only. The descriptor surface mirrors
  // `Export`'s gate by spec; owner / office hold the perm, worker /
  // bookkeeper do not.
  // -------------------------------------------------------------------
  describe('permission gate', () => {
    it('returns 401 UNAUTHENTICATED for an unauthenticated request', async () => {
      const res = await authGet('', '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHENTICATED');
    });

    it('returns 403 NOT_PERMITTED for a worker (lacks data:export)', async () => {
      const res = await authGet(workerToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('returns 403 NOT_PERMITTED for a bookkeeper (lacks data:export)', async () => {
      const res = await authGet(bookkeeperToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('returns 200 for an owner (holds data:export)', async () => {
      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(200);
    });

    it('returns 200 for office (holds data:export)', async () => {
      const res = await authGet(officeToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // Payload shape — every documented `BinaryDescriptor` field is present
  // for a fetchable row, the fetch triple lands together OR the error
  // tag does (never both, never neither), and the unwrapped DEK matches
  // the row's freshly-unwrapped envelope.
  // -------------------------------------------------------------------
  describe('payload shape', () => {
    it('returns BinaryDescriptor entries with every documented field for a fetchable row', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 1234, kind: 'binary', label: 'rechnung', fileName: 'invoice.pdf' },
      ]);
      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(200);
      const page = res.json() as DescriptorPage;
      expect(page.entries).toHaveLength(1);
      const e = page.entries[0]!;
      expect(typeof e.attachmentId).toBe('string');
      expect(typeof e.projectId).toBe('string');
      expect(typeof e.projectNumber).toBe('string');
      expect(typeof e.projectTitle).toBe('string');
      expect(typeof e.fileName).toBe('string');
      expect(typeof e.sizeBytes).toBe('number');
      expect(e.sizeBytes).toBe(1234);
      expect(e.fileName).toBe('invoice.pdf');
      expect(typeof e.originalUrl).toBe('string');
      expect(typeof e.originalDekMaterial).toBe('string');
      expect(typeof e.expiresAt).toBe('string');
      // expiresAt parses as a real Date.
      expect(Number.isNaN(Date.parse(e.expiresAt!))).toBe(false);
      // 32 bytes after base64-decode — the AES-256-GCM key shape.
      expect(Buffer.from(e.originalDekMaterial!, 'base64').length).toBe(32);
      // The error tag is absent on the fetchable arm.
      expect(e.error).toBeUndefined();
    });

    it('originalDekMaterial matches the freshly-unwrapped wrappedDek for the row', async () => {
      // End-to-end DEK fidelity — drives the unwrap path. Seed with a
      // known DEK, then assert the descriptor surface returned exactly
      // those 32 bytes. A regression that returned a constant DEK or
      // swapped envelopes across rows fails byte-equality.
      await wipeAttachments();
      const seeded = await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, kind: 'binary', fileName: 'fidelity.pdf' },
      ]);
      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(200);
      const page = res.json() as DescriptorPage;
      expect(page.entries).toHaveLength(1);
      const returned = Buffer.from(page.entries[0]!.originalDekMaterial!, 'base64');
      expect(returned.length).toBe(32);
      expect(returned.equals(seeded[0]!.dek)).toBe(true);
    });

    it('discriminator: every entry carries the fetch triple OR error, never both, never neither', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [{ sizeBytes: 100, fileName: 'ok.pdf' }]);
      await seedReadyWithCorruptEnvelope(projectAId, 'corrupt.pdf');

      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(200);
      const page = res.json() as DescriptorPage;
      expect(page.entries).toHaveLength(2);

      for (const e of page.entries) {
        const hasTriple =
          e.originalUrl !== undefined &&
          e.originalDekMaterial !== undefined &&
          e.expiresAt !== undefined;
        const hasError = e.error !== undefined;
        // Mutually exclusive — the discriminator is the load-bearing
        // contract for the client's per-row skip path.
        expect(hasTriple !== hasError).toBe(true);
        // And never the partial shape: triple-half present without the
        // others, or error-tag plus URL.
        if (hasError) {
          expect(e.originalUrl).toBeUndefined();
          expect(e.originalDekMaterial).toBeUndefined();
          expect(e.expiresAt).toBeUndefined();
          expect(e.error).toBe('DEK_UNWRAP_FAILED');
        }
      }
    });
  });

  // -------------------------------------------------------------------
  // Pagination — `(createdAt, id)` ascending cursor, `nextCursor=null`
  // terminates iteration, no-cursor first call, late-insert lands after
  // the cursor.
  // -------------------------------------------------------------------
  describe('pagination', () => {
    it('first call needs no cursor; nextCursor=null when the iteration ends in one page', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, fileName: 'a.pdf' },
        { sizeBytes: 200, fileName: 'b.pdf' },
      ]);
      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(200);
      const page = res.json() as DescriptorPage;
      expect(page.entries).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it('iterates ascending (createdAt, id); nextCursor non-null until the last page', async () => {
      await wipeAttachments();
      // Three rows with monotonically-increasing createdAt — the cursor
      // must be defined as `(createdAt, id)` ascending per AC-248.
      const t = (n: number): Date => new Date(`2026-01-01T00:00:0${n}.000Z`);
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, fileName: 'first.pdf', createdAt: t(1) },
        { sizeBytes: 200, fileName: 'second.pdf', createdAt: t(2) },
        { sizeBytes: 300, fileName: 'third.pdf', createdAt: t(3) },
      ]);

      // Two pages of two — page 1 returns first + second, with a cursor;
      // page 2 returns third with `nextCursor=null`.
      const page1 = (await authGet(ownerToken, '/api/export/binary-descriptors?limit=2').then((r) =>
        r.json(),
      )) as DescriptorPage;
      expect(page1.entries.map((e) => e.fileName)).toEqual(['first.pdf', 'second.pdf']);
      expect(typeof page1.nextCursor).toBe('string');
      expect(page1.nextCursor!.length).toBeGreaterThan(0);

      const page2 = (await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=2&after=${encodeURIComponent(page1.nextCursor!)}`,
      ).then((r) => r.json())) as DescriptorPage;
      expect(page2.entries.map((e) => e.fileName)).toEqual(['third.pdf']);
      expect(page2.nextCursor).toBeNull();
    });

    it('a row inserted between pages with createdAt > cursor lands in a later page', async () => {
      await wipeAttachments();
      const t = (n: number): Date => new Date(`2026-02-01T00:00:0${n}.000Z`);
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, fileName: 'one.pdf', createdAt: t(1) },
        { sizeBytes: 200, fileName: 'two.pdf', createdAt: t(2) },
      ]);

      // Drain page 1 (limit=1) — cursor now points just past `one.pdf`.
      const page1 = (await authGet(ownerToken, '/api/export/binary-descriptors?limit=1').then((r) =>
        r.json(),
      )) as DescriptorPage;
      expect(page1.entries.map((e) => e.fileName)).toEqual(['one.pdf']);
      expect(typeof page1.nextCursor).toBe('string');

      // Insert a row with `createdAt` AFTER the cursor — must land after
      // `two.pdf` in the iteration (`(createdAt, id)` ascending).
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 300, fileName: 'late.pdf', createdAt: t(3) },
      ]);

      const page2 = (await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=10&after=${encodeURIComponent(page1.nextCursor!)}`,
      ).then((r) => r.json())) as DescriptorPage;
      // `two.pdf` first (lower createdAt), then `late.pdf`.
      expect(page2.entries.map((e) => e.fileName)).toEqual(['two.pdf', 'late.pdf']);
    });

    it('cursor stability under identical createdAt — id is the tiebreaker', async () => {
      // AC-248 cursor is `(createdAt, id)` ascending. When two rows
      // share the same `createdAt`, the `id` half is what disambiguates
      // them across pages — without an `id` tiebreaker an iteration
      // could skip or duplicate a row at the page boundary. Pin both
      // halves of the contract: the two rows appear exactly once across
      // the two pages, no skip, no duplicate.
      await wipeAttachments();
      const tied = new Date('2026-05-01T12:00:00.000Z');
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, fileName: 'tie-a.pdf', createdAt: tied },
        { sizeBytes: 200, fileName: 'tie-b.pdf', createdAt: tied },
      ]);

      const page1 = (await authGet(ownerToken, '/api/export/binary-descriptors?limit=1').then((r) =>
        r.json(),
      )) as DescriptorPage;
      expect(page1.entries).toHaveLength(1);
      expect(typeof page1.nextCursor).toBe('string');

      const page2 = (await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=1&after=${encodeURIComponent(page1.nextCursor!)}`,
      ).then((r) => r.json())) as DescriptorPage;
      expect(page2.entries).toHaveLength(1);

      // Each row appears exactly once across the two pages — the
      // `(createdAt, id)` tiebreaker is what makes this hold under
      // identical timestamps.
      const seen = new Set<string>();
      for (const e of [...page1.entries, ...page2.entries]) {
        seen.add(e.attachmentId);
      }
      expect(seen.size).toBe(2);
      const fileNames = new Set([...page1.entries, ...page2.entries].map((e) => e.fileName));
      expect(fileNames.has('tie-a.pdf')).toBe(true);
      expect(fileNames.has('tie-b.pdf')).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // totalCount + totalSizeBytes — server-computed at first-page
  // composition; identical across subsequent pages within the iteration.
  // -------------------------------------------------------------------
  describe('totalCount and totalSizeBytes', () => {
    it('totalCount equals row count and totalSizeBytes equals summed plaintext sizeBytes', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, fileName: 'a.pdf' },
        { sizeBytes: 250, fileName: 'b.pdf' },
        { sizeBytes: 1000, fileName: 'c.pdf' },
      ]);
      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      const page = res.json() as DescriptorPage;
      expect(page.totalCount).toBe(3);
      expect(page.totalSizeBytes).toBe(100 + 250 + 1000);
    });

    it('subsequent pages return identical totalCount and totalSizeBytes (snapshot semantics)', async () => {
      await wipeAttachments();
      const t = (n: number): Date => new Date(`2026-03-01T00:00:0${n}.000Z`);
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, fileName: 'p1.pdf', createdAt: t(1) },
        { sizeBytes: 200, fileName: 'p2.pdf', createdAt: t(2) },
        { sizeBytes: 400, fileName: 'p3.pdf', createdAt: t(3) },
      ]);
      const page1 = (await authGet(ownerToken, '/api/export/binary-descriptors?limit=1').then((r) =>
        r.json(),
      )) as DescriptorPage;
      const page2 = (await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=1&after=${encodeURIComponent(page1.nextCursor!)}`,
      ).then((r) => r.json())) as DescriptorPage;
      const page3 = (await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=1&after=${encodeURIComponent(page2.nextCursor!)}`,
      ).then((r) => r.json())) as DescriptorPage;
      expect(page2.totalCount).toBe(page1.totalCount);
      expect(page3.totalCount).toBe(page1.totalCount);
      expect(page2.totalSizeBytes).toBe(page1.totalSizeBytes);
      expect(page3.totalSizeBytes).toBe(page1.totalSizeBytes);
      expect(page1.totalCount).toBe(3);
      expect(page1.totalSizeBytes).toBe(100 + 200 + 400);
    });

    it('mid-drain mutation does not leak into pinned totals (stability invariant)', async () => {
      // Strengthens the snapshot-semantics guarantee: api.md §14.2.4
      // pins that totals "do not change within the iteration" even
      // when "a row [is] inserted, deleted, or status-changed during
      // the iteration". A per-page recompute would silently drift here;
      // pinning the totals into the cursor on first-page composition is
      // what keeps them sticky end-to-end.
      await wipeAttachments();
      const t = (n: number): Date => new Date(`2026-03-02T00:00:0${n}.000Z`);
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, fileName: 'm1.pdf', createdAt: t(1) },
        { sizeBytes: 200, fileName: 'm2.pdf', createdAt: t(2) },
        { sizeBytes: 400, fileName: 'm3.pdf', createdAt: t(3) },
      ]);
      const page1 = (await authGet(ownerToken, '/api/export/binary-descriptors?limit=1').then((r) =>
        r.json(),
      )) as DescriptorPage;
      expect(page1.totalCount).toBe(3);
      expect(page1.totalSizeBytes).toBe(100 + 200 + 400);

      // Mutate state mid-drain — insert a fourth ready row that, on a
      // naive per-page recompute, would shift totalCount to 4 and
      // totalSizeBytes by +800. The cursor-pinned totals must not move.
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 800, fileName: 'm4.pdf', createdAt: t(4) },
      ]);

      const page2 = (await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=1&after=${encodeURIComponent(page1.nextCursor!)}`,
      ).then((r) => r.json())) as DescriptorPage;
      expect(page2.totalCount).toBe(page1.totalCount);
      expect(page2.totalSizeBytes).toBe(page1.totalSizeBytes);

      // And the same again on page 3 — the pinned values must ride the
      // entire iteration, not just one cursor hop.
      const page3 = (await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=1&after=${encodeURIComponent(page2.nextCursor!)}`,
      ).then((r) => r.json())) as DescriptorPage;
      expect(page3.totalCount).toBe(page1.totalCount);
      expect(page3.totalSizeBytes).toBe(page1.totalSizeBytes);
    });
  });

  // -------------------------------------------------------------------
  // Scope filter — `pending` and `hidden` rows are excluded by
  // construction (only `status='ready'` enumerates).
  // -------------------------------------------------------------------
  describe('scope filter — only status=ready', () => {
    it('excludes pending rows and hidden rows from entries, totalCount, and totalSizeBytes', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [{ sizeBytes: 500, fileName: 'visible.pdf' }]);
      await seedPendingAttachment(projectAId);
      await seedHiddenAttachment(projectAId);

      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      const page = res.json() as DescriptorPage;
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]!.fileName).toBe('visible.pdf');
      expect(page.totalCount).toBe(1);
      expect(page.totalSizeBytes).toBe(500);
    });
  });

  // -------------------------------------------------------------------
  // Unscoped surface — the admitting roles (owner / office) are
  // unscoped under `attachmentScopeForCaller` (AC-217), so the descriptor
  // enumeration covers every row regardless of project assignment.
  // -------------------------------------------------------------------
  describe('unscoped surface', () => {
    it('owner sees rows on every project (assigned or not)', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [{ sizeBytes: 100, fileName: 'on-A.pdf' }]);
      // projectBId is unassigned for the worker — but for owner the
      // descriptor surface must enumerate it just the same.
      await seedReadyAttachments(projectBId, [{ sizeBytes: 200, fileName: 'on-B.pdf' }]);
      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      const page = res.json() as DescriptorPage;
      const fileNames = new Set(page.entries.map((e) => e.fileName));
      expect(fileNames.has('on-A.pdf')).toBe(true);
      expect(fileNames.has('on-B.pdf')).toBe(true);
      expect(page.totalCount).toBe(2);
    });

    it('office sees rows on every project (assigned or not)', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [{ sizeBytes: 100, fileName: 'on-A.pdf' }]);
      await seedReadyAttachments(projectBId, [{ sizeBytes: 200, fileName: 'on-B.pdf' }]);
      const res = await authGet(officeToken, '/api/export/binary-descriptors');
      const page = res.json() as DescriptorPage;
      const fileNames = new Set(page.entries.map((e) => e.fileName));
      expect(fileNames.has('on-A.pdf')).toBe(true);
      expect(fileNames.has('on-B.pdf')).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // No-audit assertion — parity with the existing `Export` operation
  // (api.md §14.2.4 design note + verification.md AC-248). The descriptor
  // surface is a read; the audit-log invariant ties rows to mutations,
  // and a synthetic audit row would violate AC-177.
  // -------------------------------------------------------------------
  describe('no audit_log row produced', () => {
    it('first-page request emits zero audit rows', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [{ sizeBytes: 100, fileName: 'x.pdf' }]);
      const before = await countAuditRows();
      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(200);
      const after = await countAuditRows();
      expect(after - before).toBe(0);
    });

    it('paginated iteration (every page) emits zero audit rows', async () => {
      await wipeAttachments();
      const t = (n: number): Date => new Date(`2026-04-01T00:00:0${n}.000Z`);
      await seedReadyAttachments(projectAId, [
        { sizeBytes: 100, fileName: '1.pdf', createdAt: t(1) },
        { sizeBytes: 200, fileName: '2.pdf', createdAt: t(2) },
        { sizeBytes: 300, fileName: '3.pdf', createdAt: t(3) },
      ]);
      const before = await countAuditRows();

      // Each call must succeed AND advance through the iteration —
      // asserting `statusCode === 200` and a non-null `nextCursor`
      // before the audit-row diff makes the test fail meaningfully
      // today (404 path) AND in the future (regression: a no-op
      // descriptor surface that returns 200 + empty entries would
      // also tautologically pass the audit diff). T-TAUT defense.
      const r1 = await authGet(ownerToken, '/api/export/binary-descriptors?limit=1');
      expect(r1.statusCode).toBe(200);
      const page1 = r1.json() as DescriptorPage;
      expect(page1.nextCursor).not.toBeNull();

      const r2 = await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=1&after=${encodeURIComponent(page1.nextCursor!)}`,
      );
      expect(r2.statusCode).toBe(200);
      const page2 = r2.json() as DescriptorPage;
      expect(page2.nextCursor).not.toBeNull();

      const r3 = await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=1&after=${encodeURIComponent(page2.nextCursor!)}`,
      );
      expect(r3.statusCode).toBe(200);

      const after = await countAuditRows();
      expect(after - before).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Per-row inline DEK_UNWRAP_FAILED — a single corrupt envelope must
  // surface as an inline error tag, NOT escalate to a page-level 500.
  // -------------------------------------------------------------------
  describe('per-row inline DEK_UNWRAP_FAILED', () => {
    it('a single corrupt envelope on the page surfaces inline; the page itself remains 200', async () => {
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [{ sizeBytes: 100, fileName: 'good.pdf' }]);
      const corruptId = await seedReadyWithCorruptEnvelope(projectAId, 'corrupt.pdf');

      const res = await authGet(ownerToken, '/api/export/binary-descriptors');
      expect(res.statusCode).toBe(200);
      const page = res.json() as DescriptorPage;
      expect(page.entries).toHaveLength(2);

      const corrupt = page.entries.find((e) => e.attachmentId === corruptId)!;
      expect(corrupt.error).toBe('DEK_UNWRAP_FAILED');
      expect(corrupt.originalUrl).toBeUndefined();
      expect(corrupt.originalDekMaterial).toBeUndefined();
      expect(corrupt.expiresAt).toBeUndefined();
      // The other row is fully fetchable.
      const good = page.entries.find((e) => e.fileName === 'good.pdf')!;
      expect(typeof good.originalUrl).toBe('string');
      expect(typeof good.originalDekMaterial).toBe('string');
      expect(good.error).toBeUndefined();
      // totalCount counts the corrupt row too — it's still a `ready`
      // attachment in the iteration; the client decides to skip it.
      expect(page.totalCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // Error paths — malformed cursor / out-of-bounds limit → 422; wholesale
  // unwrap failure → 500. Categories per api.md §14.4.1.
  // -------------------------------------------------------------------
  describe('error paths', () => {
    it('malformed cursor returns 422 VALIDATION_ERROR', async () => {
      const res = await authGet(
        ownerToken,
        `/api/export/binary-descriptors?after=${encodeURIComponent('not-a-real-cursor')}`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('limit above the configured ceiling returns 422 VALIDATION_ERROR', async () => {
      const res = await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=${PER_PAGE_CEILING + 1}`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('limit at or below zero returns 422 VALIDATION_ERROR', async () => {
      // The per-page bounds open above zero — `limit=0` and negatives
      // are out-of-bounds inputs. Spec wording: "limit outside the
      // configured per-page bounds → 422".
      const res = await authGet(ownerToken, '/api/export/binary-descriptors?limit=0');
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('limit at the documented default succeeds (sanity check on the bounds wording)', async () => {
      // Anchors the rejection arms above — without this, a regression
      // that rejected every limit would tautologically pass them.
      await wipeAttachments();
      await seedReadyAttachments(projectAId, [{ sizeBytes: 100, fileName: 'sanity.pdf' }]);
      const res = await authGet(
        ownerToken,
        `/api/export/binary-descriptors?limit=${PER_PAGE_DEFAULT}`,
      );
      expect(res.statusCode).toBe(200);
    });

    it.skip('wholesale 500 (binary age identity not loaded) — non-reachable in steady state', () => {
      // AC-248: wholesale-500 trigger is "operator's binary `age` identity not loaded".
      // The boot probe (binary-identity-probe.test.ts) blocks startup without it, so this path
      // is non-reachable at the integration layer. Per-row corruption is the inline-error path,
      // not this one — see the per-row DEK_UNWRAP_FAILED suite above.
    });
  });
});
