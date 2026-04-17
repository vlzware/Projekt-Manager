/**
 * API integration tests: Unified Data Exchange.
 *
 * Covers AC-133 through AC-141 (verification.md §15.14) for the unified
 * business-data export/import surface introduced by ADR-0018:
 *
 *   GET  /api/export             → envelope snapshot (permission: data:export)
 *   POST /api/import[?flags]     → restore-only import    (permission: data:restore)
 *
 * Envelope shape (data-model.md §5.8):
 *   { schema_version: number,
 *     exported_at: ISO 8601,
 *     customers: Customer[],
 *     projects: Project[],
 *     project_workers: { projectId, userId }[] }
 *
 * Written ahead of implementation (TDD). Until the endpoints exist these
 * tests fail with HTTP 404 or assertion mismatches — never with TypeScript
 * compile errors. The test file defines the contract; the implementation
 * catches up.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  getApp,
  authDelete,
} from '../../test/api-helpers.js';
import {
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
  EXPECTED_RESTORE_PHRASE,
} from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import type { Database } from '../db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/**
 * Current schema version. Exports must stamp this value; imports must
 * reject any mismatch (see ADR-0018 §Decision — strict version rejection,
 * no data-format migration code).
 *
 * When `src/server/seed.ts` or data-model.md §5.8 bumps the schema, bump
 * this constant; the import should then reject the old value the next
 * test run, which is exactly the test's purpose.
 */
const CURRENT_SCHEMA_VERSION = 1;

const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

/**
 * Deterministic UUID factory for fixture envelopes. The prefix is hex-
 * encoded so non-hex category markers like `cust` / `proj` stay usable
 * in fixture code without producing invalid PG uuid syntax.
 */
function uuid(prefix: string, i: number): string {
  const hex = Array.from(prefix)
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(8, '0')
    .slice(0, 8);
  const n = String(i).padStart(12, '0');
  return `${hex}-0000-4000-8000-${n}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Build an envelope for the empty-DB import path. Fresh IDs so the test
 * can verify ID preservation after export→import→export.
 */
function buildFreshEnvelope(): ExportEnvelope {
  const customerId = uuid('cust', 1);
  const projectId = uuid('proj', 1);
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    exported_at: isoNow(),
    customers: [
      {
        id: customerId,
        name: 'Import Kunde Alpha',
        phone: '0221-9000001',
        email: 'alpha@example.de',
        address: { street: 'Ringstr. 1', zip: '50667', city: 'Köln' },
        notes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    projects: [
      {
        id: projectId,
        number: '2026-900',
        title: 'Import Projekt Alpha',
        status: 'anfrage',
        statusChangedAt: '2026-01-05T00:00:00.000Z',
        customerId,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: false,
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    project_workers: [],
  };
}

/**
 * Build an envelope distinct from the seed — different IDs, names, and
 * counts — so override-vs-seed tests can detect wipe-and-restore.
 */
function buildOverrideEnvelope(): ExportEnvelope {
  const c1 = uuid('cust', 10);
  const c2 = uuid('cust', 11);
  const p1 = uuid('proj', 10);
  const p2 = uuid('proj', 11);
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    exported_at: isoNow(),
    customers: [
      {
        id: c1,
        name: 'Override Kunde Eins',
        phone: null,
        email: null,
        address: null,
        notes: null,
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
      {
        id: c2,
        name: 'Override Kunde Zwei',
        phone: null,
        email: null,
        address: null,
        notes: null,
        createdAt: '2026-02-02T00:00:00.000Z',
        updatedAt: '2026-02-02T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    projects: [
      {
        id: p1,
        number: '2026-OV-1',
        title: 'Override Projekt Eins',
        status: 'anfrage',
        statusChangedAt: '2026-02-05T00:00:00.000Z',
        customerId: c1,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: false,
        createdAt: '2026-02-05T00:00:00.000Z',
        updatedAt: '2026-02-05T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
      {
        id: p2,
        number: '2026-OV-2',
        title: 'Override Projekt Zwei (archived)',
        status: 'erledigt',
        statusChangedAt: '2026-02-06T00:00:00.000Z',
        customerId: c2,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: true,
        createdAt: '2026-02-06T00:00:00.000Z',
        updatedAt: '2026-02-06T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    project_workers: [],
  };
}

/**
 * Shape we assert against. Any field the current export omits makes the
 * corresponding assertion fail loudly — that is the entire point of the
 * row-level-fidelity AC.
 */
interface ExportEnvelope {
  schema_version: number;
  exported_at: string;
  customers: Array<Record<string, unknown> & { id: string }>;
  projects: Array<Record<string, unknown> & { id: string; deleted: boolean }>;
  project_workers: Array<{ projectId: string; userId: string }>;
  // Index signature so an envelope is assignable to the authPost payload
  // type Record<string, unknown> without per-call casting.
  [key: string]: unknown;
}

// ---------------------------------------------------------------
// A dedicated db/pool for direct-SQL operations the API does not cover
// (wiping business data between tests so the "empty DB" and "atomic
// rollback" branches are exercised). Uses the same connection string as
// the app — two pools against the same PG instance are fine; data-integrity
// tests do the same.
// ---------------------------------------------------------------
let db: Database;
let pool: pg.Pool;

async function wipeBusinessData(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE project_workers, projects, customers RESTART IDENTITY CASCADE`,
  );
}

/**
 * Re-seed the database. Because `seed(..., { force: true })` TRUNCATEs the
 * sessions table (see src/server/seed.ts), every previously-issued session
 * token becomes invalid. Callers MUST refresh any tokens they hold —
 * see `reseedAndRelogin` below. Using `reseed()` directly is intentional
 * for the initial startApp() path (no tokens yet).
 */
async function reseed(): Promise<void> {
  await seed(db, { force: true });
}

describe('Unified Data Exchange', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  /**
   * Reseed + refresh all session tokens. Seed TRUNCATEs sessions, so any
   * token obtained before the call becomes invalid (401 on next request).
   * Tests that reseed between sub-cases MUST call this, not plain `reseed()`.
   */
  async function reseedAndRelogin(): Promise<void> {
    await reseed();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
    bookkeeperToken = await login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD);
  }

  beforeAll(async () => {
    await startApp();

    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });

    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
    bookkeeperToken = await login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AC-133: export rejects unauthenticated or unauthorized callers
  // ---------------------------------------------------------------
  describe('AC-133: export auth gate', () => {
    // AC-133: unauthenticated GET /api/export → 401 (UNAUTHENTICATED)
    it('returns 401 when not authenticated', async () => {
      const res = await getApp().inject({ method: 'GET', url: '/api/export' });
      expect(res.statusCode).toBe(401);
    });

    // AC-133: workers lack data:export → 403 NOT_PERMITTED
    it('returns 403 NOT_PERMITTED for worker (lacks data:export)', async () => {
      const res = await authGet(workerToken, '/api/export');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    // AC-133: bookkeepers lack data:export → 403 NOT_PERMITTED
    it('returns 403 NOT_PERMITTED for bookkeeper (lacks data:export)', async () => {
      const res = await authGet(bookkeeperToken, '/api/export');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    // AC-133: owner has data:export → 200
    it('returns 200 for owner (holds data:export)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      expect(res.statusCode).toBe(200);
    });

    // AC-133: office has data:export → 200
    it('returns 200 for office (holds data:export)', async () => {
      const res = await authGet(officeToken, '/api/export');
      expect(res.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------
  // AC-134: import rejects unauthenticated or unauthorized callers
  // ---------------------------------------------------------------
  describe('AC-134: import auth gate', () => {
    // AC-134: unauthenticated POST /api/import → 401 UNAUTHENTICATED
    it('returns 401 when not authenticated', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/import',
        payload: buildFreshEnvelope(),
      });
      expect(res.statusCode).toBe(401);
    });

    // AC-134: office does NOT hold data:restore (owner-only per §14.3) → 403
    it('returns 403 NOT_PERMITTED for office (lacks data:restore)', async () => {
      const res = await authPost(officeToken, '/api/import', buildFreshEnvelope());
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    // AC-134: worker lacks data:restore → 403
    it('returns 403 NOT_PERMITTED for worker (lacks data:restore)', async () => {
      const res = await authPost(workerToken, '/api/import', buildFreshEnvelope());
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    // AC-134: bookkeeper lacks data:restore → 403
    it('returns 403 NOT_PERMITTED for bookkeeper (lacks data:restore)', async () => {
      const res = await authPost(bookkeeperToken, '/api/import', buildFreshEnvelope());
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    // AC-134: owner holds data:restore; into empty DB a valid envelope
    // is accepted (200). We wipe + restore-seed around this case so sibling
    // tests see the seed unchanged.
    it('returns 200 for owner (holds data:restore) on empty DB', async () => {
      await wipeBusinessData();
      try {
        const res = await authPost(ownerToken, '/api/import', buildFreshEnvelope());
        expect(res.statusCode).toBe(200);
      } finally {
        await reseedAndRelogin();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-135: export envelope shape and row-level fidelity
  // ---------------------------------------------------------------
  describe('AC-135: export envelope shape', () => {
    let archivedProjectId: string;

    // Soft-delete one seeded project so the "archived rows are included"
    // branch has something to check. Archived rows must still appear in
    // the export with `deleted: true`.
    beforeAll(async () => {
      // Seed is already in place from the outer beforeAll; don't wipe it
      // here (that would invalidate tokens the outer describe just
      // issued). Just soft-delete a project.
      const list = await authGet(ownerToken, '/api/projects');
      const projects = list.json().data as Array<{ id: string; status: string }>;
      const target = projects.find((p) => p.status === 'angebot') ?? projects[0]!;
      archivedProjectId = target.id;
      const del = await authDelete(ownerToken, `/api/projects/${archivedProjectId}`);
      expect(del.statusCode).toBe(200);
    });

    afterAll(async () => {
      // Restore the seed so downstream describes see the canonical dataset.
      await reseedAndRelogin();
    });

    // AC-135: top-level envelope contains schema_version, exported_at,
    // customers[], projects[], project_workers[] — every field present.
    it('returns schema_version, exported_at, customers, projects, project_workers', async () => {
      const res = await authGet(ownerToken, '/api/export');
      expect(res.statusCode).toBe(200);

      const env = res.json() as ExportEnvelope;
      expect(typeof env.schema_version).toBe('number');
      expect(env.schema_version).toBe(CURRENT_SCHEMA_VERSION);

      expect(typeof env.exported_at).toBe('string');
      // Must parse as a real Date (not NaN).
      expect(Number.isNaN(Date.parse(env.exported_at))).toBe(false);

      expect(Array.isArray(env.customers)).toBe(true);
      expect(Array.isArray(env.projects)).toBe(true);
      expect(Array.isArray(env.project_workers)).toBe(true);
    });

    // AC-135: customers.length matches the seeded row count (21 per
    // src/server/seed.ts). Off-by-one = seed drift the test should surface.
    it('exports every seeded customer (21 from seed)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelope;
      expect(env.customers.length).toBe(21);
    });

    // AC-135: projects count matches seeded count INCLUDING archived rows.
    // Seed = 19 projects; none are archived in seed. We soft-deleted one
    // above, so the export must still include 19 (archived = included).
    it('exports every project INCLUDING archived (deleted=true) rows', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelope;
      expect(env.projects.length).toBe(19);

      const archived = env.projects.find((p) => p.id === archivedProjectId);
      expect(archived).toBeDefined();
      expect(archived!.deleted).toBe(true);
    });

    // AC-135: row-level fidelity — every customer carries id,createdAt,updatedAt.
    it('customer rows carry id, createdAt, updatedAt', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelope;
      for (const c of env.customers) {
        expect(typeof c.id).toBe('string');
        expect(c.createdAt).toBeDefined();
        expect(c.updatedAt).toBeDefined();
      }
    });

    // AC-135: row-level fidelity — every project carries id,createdAt,updatedAt,deleted.
    it('project rows carry id, createdAt, updatedAt, deleted', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelope;
      for (const p of env.projects) {
        expect(typeof p.id).toBe('string');
        expect(p.createdAt).toBeDefined();
        expect(p.updatedAt).toBeDefined();
        expect(typeof p.deleted).toBe('boolean');
      }
    });

    // AC-135: project_workers entries carry projectId and userId.
    it('project_workers rows carry projectId and userId', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelope;
      // Seed has 7 assignments — but this test does not pin the count,
      // only that whatever is returned has the documented shape.
      for (const a of env.project_workers) {
        expect(typeof a.projectId).toBe('string');
        expect(typeof a.userId).toBe('string');
      }
    });

    // AC-135 (exclusion): users, sessions, password hashes must not appear
    // anywhere in the serialized envelope. Grep-style check on the JSON
    // string catches accidental inclusion via row spread / serializer leak.
    it('does NOT serialize users, sessions, or password fields', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const serialized = res.body;
      expect(serialized).not.toMatch(/"users"\s*:/);
      expect(serialized).not.toMatch(/"sessions"\s*:/);
      expect(serialized.toLowerCase()).not.toContain('passwordhash');
      expect(serialized.toLowerCase()).not.toContain('password_hash');
      expect(serialized).not.toMatch(/"password"\s*:/);
    });
  });

  // ---------------------------------------------------------------
  // AC-136: schema_version mismatch is rejected, with no writes
  // ---------------------------------------------------------------
  describe('AC-136: schema_version mismatch rejection', () => {
    // AC-136: envelope version current+1 → rejected with specific code, no writes.
    it('rejects an envelope with a newer schema_version', async () => {
      const before = await authGet(ownerToken, '/api/export');
      const baseline = before.json() as ExportEnvelope;

      const bad = buildOverrideEnvelope();
      bad.schema_version = CURRENT_SCHEMA_VERSION + 1;
      const body = { ...bad, confirmation_phrase: EXPECTED_RESTORE_PHRASE };
      const res = await authPost(ownerToken, '/api/import?override=true', body);

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.json().code).toBe('SCHEMA_VERSION_MISMATCH');

      const after = await authGet(ownerToken, '/api/export');
      const post = after.json() as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
    });

    // AC-136: envelope version current-1 → same rejection. No migration.
    it('rejects an envelope with an older schema_version', async () => {
      const bad = buildOverrideEnvelope();
      bad.schema_version = CURRENT_SCHEMA_VERSION - 1;
      const body = { ...bad, confirmation_phrase: EXPECTED_RESTORE_PHRASE };
      const res = await authPost(ownerToken, '/api/import?override=true', body);

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.json().code).toBe('SCHEMA_VERSION_MISMATCH');
    });
  });

  // ---------------------------------------------------------------
  // AC-137: import into empty DB preserves IDs, all-or-nothing
  // ---------------------------------------------------------------
  describe('AC-137: import into empty DB', () => {
    // AC-137 happy path: empty target, valid envelope → 200 and IDs match.
    it('imports a valid envelope and preserves row IDs exactly', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const res = await authPost(ownerToken, '/api/import', envelope);
        expect(res.statusCode).toBe(200);

        const exp = await authGet(ownerToken, '/api/export');
        const out = exp.json() as ExportEnvelope;

        const customerIds = new Set(out.customers.map((c) => c.id));
        for (const c of envelope.customers) expect(customerIds.has(c.id)).toBe(true);

        const projectIds = new Set(out.projects.map((p) => p.id));
        for (const p of envelope.projects) expect(projectIds.has(p.id)).toBe(true);
      } finally {
        await reseedAndRelogin();
      }
    });

    // AC-137 atomicity: an envelope with a project referencing a customer
    // NOT in `customers` must fail the whole transaction — the earlier,
    // valid rows must not be persisted.
    it('rolls back entirely if any row is invalid (atomic import)', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        // Replace the last project's customerId with a non-existent one.
        const broken = {
          ...envelope,
          projects: [
            ...envelope.projects,
            {
              ...envelope.projects[0]!,
              id: uuid('proj', 99),
              number: '2026-999',
              customerId: UUID_ZERO, // references nothing
            },
          ],
        };
        const res = await authPost(ownerToken, '/api/import', broken);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);

        // DB must still be empty — neither the valid project nor the
        // "valid" customer should have been persisted.
        const exp = await authGet(ownerToken, '/api/export');
        const out = exp.json() as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
        expect(out.project_workers.length).toBe(0);
      } finally {
        await reseedAndRelogin();
      }
    });
  });

  // ---------------------------------------------------------------
  // Envelope uniqueness validation
  //
  // Referential integrity alone is not enough: an envelope with two
  // customers sharing the same id (or two projects sharing the same id /
  // the same number, or two project_workers rows with the same composite
  // key) currently slips past `validateEnvelopeReferences` and reaches the
  // INSERT, where Postgres raises a 23505 unique-violation that surfaces
  // to the caller as a generic 500. The validation layer must catch these
  // collisions up-front and return the same 422 VALIDATION_ERROR shape
  // used by the referential-integrity checks — so dry-run can preview
  // them without a write, and non-dry-run never touches the DB at all.
  // ---------------------------------------------------------------
  describe('Envelope uniqueness validation', () => {
    // Start from an empty DB so a duplicate-detection failure cannot be
    // confused with TARGET_NOT_EMPTY (AC-138) or with a collision against
    // the seed. The seed is restored in the finally of each test.
    //
    // Note: `wipeBusinessData()` truncates business tables only — the
    // `users` table survives, so seeded user IDs (if any are needed in a
    // test) remain valid. The tests below do not rely on that, because
    // validation must reject duplicate composite keys before any insert.

    it('rejects duplicate customer ids (non-dry-run) with 422 VALIDATION_ERROR', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const dupId = envelope.customers[0]!.id;
        envelope.customers.push({
          ...envelope.customers[0]!,
          // Same id as customers[0] — intentional collision.
          id: dupId,
          name: 'Duplicate Kunde',
          email: 'duplicate@example.de',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
        });

        const res = await authPost(ownerToken, '/api/import', envelope);

        expect(res.statusCode).toBe(422);
        const body = res.json() as {
          code: string;
          details?:
            | { validation_errors?: Array<{ path: string; message: string }> }
            | Array<{ path: string; message: string }>;
        };
        expect(body.code).toBe('VALIDATION_ERROR');

        // `details` carries the validation issues. The existing
        // referential-integrity path stores them as a plain array;
        // accept either the array-directly or a {validation_errors:[…]}
        // wrapper so the test pins structure, not incidental nesting.
        const issues = Array.isArray(body.details) ? body.details : body.details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const dup = issues!.find((i) => /customers\[1\]/.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        // No rows written — DB remains empty. This is the point of
        // validating before the transaction opens.
        const exp = await authGet(ownerToken, '/api/export');
        const out = exp.json() as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
        expect(out.project_workers.length).toBe(0);
      } finally {
        await reseedAndRelogin();
      }
    });

    it('reports duplicate customer ids in dry-run validation_errors without writes', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const dupId = envelope.customers[0]!.id;
        envelope.customers.push({
          ...envelope.customers[0]!,
          id: dupId,
          name: 'Duplicate Kunde',
          email: 'duplicate2@example.de',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
        });

        const res = await authPost(ownerToken, '/api/import?dry_run=true', envelope);
        // Dry-run never throws for invalid envelopes — the preview carries
        // the errors so the UI can render them. This is the clean proof
        // that validation (not the DB) surfaces the issue.
        expect(res.statusCode).toBe(200);

        const preview = res.json() as {
          validation_errors: Array<{ path: string; message: string }>;
        };
        expect(Array.isArray(preview.validation_errors)).toBe(true);
        const dup = preview.validation_errors.find((i) => /customers\[1\]/.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        // No state change.
        const exp = await authGet(ownerToken, '/api/export');
        const out = exp.json() as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
      } finally {
        await reseedAndRelogin();
      }
    });

    it('rejects duplicate project ids (non-dry-run) with 422 VALIDATION_ERROR', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const dupId = envelope.projects[0]!.id;
        envelope.projects.push({
          ...envelope.projects[0]!,
          // Same id as projects[0] — intentional collision.
          id: dupId,
          // Different number so the test isolates duplicate-id detection
          // from duplicate-number detection (covered by the next test).
          number: '2026-901',
          title: 'Duplicate Projekt',
          createdAt: '2026-01-06T00:00:00.000Z',
          updatedAt: '2026-01-06T00:00:00.000Z',
        });

        const res = await authPost(ownerToken, '/api/import', envelope);

        expect(res.statusCode).toBe(422);
        const body = res.json() as {
          code: string;
          details?:
            | { validation_errors?: Array<{ path: string; message: string }> }
            | Array<{ path: string; message: string }>;
        };
        expect(body.code).toBe('VALIDATION_ERROR');
        const issues = Array.isArray(body.details) ? body.details : body.details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const dup = issues!.find((i) => /projects\[1\]/.test(i.path) && /id/i.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        const exp = await authGet(ownerToken, '/api/export');
        const out = exp.json() as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
      } finally {
        await reseedAndRelogin();
      }
    });

    it('rejects two projects sharing a number (different ids) with 422', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const sharedNumber = envelope.projects[0]!.number;
        envelope.projects.push({
          ...envelope.projects[0]!,
          // Different id — uniqueness collision is on `number` only.
          id: uuid('proj', 2),
          number: sharedNumber,
          title: 'Same Number Projekt',
          createdAt: '2026-01-07T00:00:00.000Z',
          updatedAt: '2026-01-07T00:00:00.000Z',
        });

        const res = await authPost(ownerToken, '/api/import', envelope);

        expect(res.statusCode).toBe(422);
        const body = res.json() as {
          code: string;
          details?:
            | { validation_errors?: Array<{ path: string; message: string }> }
            | Array<{ path: string; message: string }>;
        };
        expect(body.code).toBe('VALIDATION_ERROR');
        const issues = Array.isArray(body.details) ? body.details : body.details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const dup = issues!.find((i) => /projects\[1\]/.test(i.path) && /number/i.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        const exp = await authGet(ownerToken, '/api/export');
        const out = exp.json() as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
      } finally {
        await reseedAndRelogin();
      }
    });

    it('rejects duplicate project_workers composite key with 422', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const projectId = envelope.projects[0]!.id;
        // userId can be any UUID: uniqueness validation must run before
        // the FK check against users. If the impl instead tried the insert,
        // it would FK-fail on this id — but the test pins that the
        // VALIDATION path rejects first, so the FK is never consulted.
        const userId = uuid('user', 1);
        envelope.project_workers = [
          { projectId, userId },
          { projectId, userId },
        ];

        const res = await authPost(ownerToken, '/api/import', envelope);

        expect(res.statusCode).toBe(422);
        const body = res.json() as {
          code: string;
          details?:
            | { validation_errors?: Array<{ path: string; message: string }> }
            | Array<{ path: string; message: string }>;
        };
        expect(body.code).toBe('VALIDATION_ERROR');
        const issues = Array.isArray(body.details) ? body.details : body.details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const dup = issues!.find((i) => /project_workers\[1\]/.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        const exp = await authGet(ownerToken, '/api/export');
        const out = exp.json() as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
        expect(out.project_workers.length).toBe(0);
      } finally {
        await reseedAndRelogin();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-138: non-empty target refused without override
  // ---------------------------------------------------------------
  describe('AC-138: non-empty target refused without override', () => {
    // AC-138: with seed present and no override flag → refused with a
    // specific error code; no state change.
    it('rejects with a conflict-category error when target is non-empty', async () => {
      // Seed is present from startApp(); confirm baseline.
      const before = await authGet(ownerToken, '/api/export');
      const baseline = before.json() as ExportEnvelope;
      expect(baseline.customers.length).toBeGreaterThan(0);

      const env = buildOverrideEnvelope();
      const res = await authPost(ownerToken, '/api/import', env);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TARGET_NOT_EMPTY');

      const after = await authGet(ownerToken, '/api/export');
      const post = after.json() as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
      // Original seeded IDs still present.
      const preIds = new Set(baseline.customers.map((c) => c.id));
      for (const c of post.customers) expect(preIds.has(c.id)).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // AC-139: override wipes+restores atomically; invalid input rolls back
  // ---------------------------------------------------------------
  describe('AC-139: override wipe+restore', () => {
    // AC-139 happy path: seed + override flag + valid envelope →
    // existing rows gone, new rows present, IDs preserved.
    it('wipes existing data and imports the new envelope when override=true', async () => {
      const before = await authGet(ownerToken, '/api/export');
      const seeded = before.json() as ExportEnvelope;
      // Sanity: seed has distinct IDs from the override envelope.
      const env = buildOverrideEnvelope();
      const seedIds = new Set(seeded.customers.map((c) => c.id));
      for (const c of env.customers) expect(seedIds.has(c.id)).toBe(false);

      try {
        const body = { ...env, confirmation_phrase: EXPECTED_RESTORE_PHRASE };
        const res = await authPost(ownerToken, '/api/import?override=true', body);
        expect(res.statusCode).toBe(200);

        const after = await authGet(ownerToken, '/api/export');
        const post = after.json() as ExportEnvelope;

        // Only the new envelope's rows survive.
        expect(post.customers.length).toBe(env.customers.length);
        expect(post.projects.length).toBe(env.projects.length);
        const newCustomerIds = new Set(post.customers.map((c) => c.id));
        for (const c of env.customers) expect(newCustomerIds.has(c.id)).toBe(true);
        // No seed survivors.
        for (const c of seeded.customers) expect(newCustomerIds.has(c.id)).toBe(false);
      } finally {
        await reseedAndRelogin();
      }
    });

    // AC-139 atomicity: invalid envelope + override → rollback, seed intact.
    it('rolls back entirely on invalid envelope even with override (atomic)', async () => {
      const before = await authGet(ownerToken, '/api/export');
      const seeded = before.json() as ExportEnvelope;

      const broken = buildOverrideEnvelope();
      // A project referencing a customerId not present in the envelope.
      broken.projects[0]!.customerId = UUID_ZERO;

      try {
        const body = { ...broken, confirmation_phrase: EXPECTED_RESTORE_PHRASE };
        const res = await authPost(ownerToken, '/api/import?override=true', body);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);

        // Seed must be unchanged — rollback covers the wipe, not just the insert.
        const after = await authGet(ownerToken, '/api/export');
        const post = after.json() as ExportEnvelope;
        expect(post.customers.length).toBe(seeded.customers.length);
        expect(post.projects.length).toBe(seeded.projects.length);
        const seededIds = new Set(seeded.customers.map((c) => c.id));
        for (const c of post.customers) expect(seededIds.has(c.id)).toBe(true);
      } finally {
        await reseedAndRelogin();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-140: dry-run — full validation, preview, no writes
  // ---------------------------------------------------------------
  describe('AC-140: dry-run import', () => {
    // AC-140 valid + dry-run: returns a preview of would-be writes, no state change.
    it('returns a preview for a valid envelope and performs no writes', async () => {
      const before = await authGet(ownerToken, '/api/export');
      const baseline = before.json() as ExportEnvelope;

      const env = buildOverrideEnvelope();
      const res = await authPost(ownerToken, '/api/import?dry_run=true', env);
      expect(res.statusCode).toBe(200);

      const preview = res.json() as {
        target_non_empty: boolean;
        would_write: { customers: number; projects: number; project_workers: number };
        validation_errors: unknown[];
      };
      expect(preview.would_write).toBeDefined();
      expect(preview.would_write.customers).toBe(env.customers.length);
      expect(preview.would_write.projects).toBe(env.projects.length);
      expect(preview.would_write.project_workers).toBe(env.project_workers.length);
      expect(Array.isArray(preview.validation_errors)).toBe(true);
      expect(preview.validation_errors.length).toBe(0);
      // AC-140 (target_non_empty): the seeded DB is non-empty, so the
      // preview must declare it. The UI uses this to gate the override
      // warning; committing without override still fails with
      // TARGET_NOT_EMPTY (AC-138).
      expect(preview.target_non_empty).toBe(true);

      // No writes.
      const after = await authGet(ownerToken, '/api/export');
      const post = after.json() as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
    });

    // AC-140 (target_non_empty, empty DB branch): dry-run against a wiped
    // target must report target_non_empty: false so the UI skips the
    // warning and enables commit directly.
    it('reports target_non_empty=false when the DB is empty', async () => {
      await wipeBusinessData();
      try {
        const env = buildFreshEnvelope();
        const res = await authPost(ownerToken, '/api/import?dry_run=true', env);
        expect(res.statusCode).toBe(200);

        const preview = res.json() as { target_non_empty: boolean };
        expect(preview.target_non_empty).toBe(false);
      } finally {
        await reseedAndRelogin();
      }
    });

    // AC-140 invalid + dry-run: preview carries validation errors, still no writes.
    it('reports validation_errors for an invalid envelope and performs no writes', async () => {
      const before = await authGet(ownerToken, '/api/export');
      const baseline = before.json() as ExportEnvelope;

      const broken = buildOverrideEnvelope();
      broken.projects[0]!.customerId = UUID_ZERO; // FK violation

      const res = await authPost(ownerToken, '/api/import?dry_run=true', broken);
      expect(res.statusCode).toBe(200);

      const preview = res.json() as { validation_errors: unknown[] };
      expect(Array.isArray(preview.validation_errors)).toBe(true);
      expect(preview.validation_errors.length).toBeGreaterThan(0);

      // Still no writes.
      const after = await authGet(ownerToken, '/api/export');
      const post = after.json() as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
    });
  });

  // ---------------------------------------------------------------
  // AC-141: roundtrip byte-equivalence (modulo exported_at)
  // ---------------------------------------------------------------
  describe('AC-141: full roundtrip produces byte-identical content', () => {
    // AC-141: seed → export1 → wipe → import(override) → export2 →
    // customers/projects/project_workers must match exactly. Only
    // exported_at may drift between runs.
    it('exports → imports → re-exports without drift (exported_at excluded)', async () => {
      const e1Res = await authGet(ownerToken, '/api/export');
      expect(e1Res.statusCode).toBe(200);
      const e1 = e1Res.json() as ExportEnvelope;

      try {
        await wipeBusinessData();

        const imp = await authPost(ownerToken, '/api/import', e1);
        expect(imp.statusCode).toBe(200);

        const e2Res = await authGet(ownerToken, '/api/export');
        expect(e2Res.statusCode).toBe(200);
        const e2 = e2Res.json() as ExportEnvelope;

        expect(e2.schema_version).toBe(e1.schema_version);
        // exported_at will differ — explicitly excluded from the compare.
        expect(typeof e2.exported_at).toBe('string');

        // Strict content equality — if a field changes on roundtrip
        // (coercion, truncation, default injection) this fails and
        // reveals the drift.
        expect(e2.customers).toEqual(e1.customers);
        expect(e2.projects).toEqual(e1.projects);
        expect(e2.project_workers).toEqual(e1.project_workers);
      } finally {
        await reseedAndRelogin();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-160: restore confirmation phrase gate
  // Server-authoritative check on override into a non-empty DB.
  // AT-82 pins enforcement (missing, case-wrong, trim, happy path).
  // AT-83 pins the two exempt paths (dry-run, empty target).
  // ---------------------------------------------------------------
  describe('AC-160: restore confirmation phrase gate', () => {
    // AT-82 — missing phrase: override into non-empty DB without a
    // `confirmation_phrase` rejects with 422 RESTORE_CONFIRMATION_MISMATCH
    // and leaves the seed untouched.
    it('rejects override into non-empty DB when confirmation_phrase is missing', async () => {
      const before = await authGet(ownerToken, '/api/export');
      const baseline = before.json() as ExportEnvelope;

      const env = buildOverrideEnvelope();
      const res = await authPost(ownerToken, '/api/import?override=true', env);

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('RESTORE_CONFIRMATION_MISMATCH');

      const after = await authGet(ownerToken, '/api/export');
      const post = after.json() as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
    });

    // AT-82 — case sensitivity: a phrase that differs only in case is
    // rejected. The body wraps the lowercased value in whitespace so a
    // permissive implementation that trimmed but ignored case would still
    // fail this test — the assertion isolates "case" from "trim".
    it('rejects override when confirmation_phrase has wrong casing', async () => {
      const before = await authGet(ownerToken, '/api/export');
      const baseline = before.json() as ExportEnvelope;

      const env = buildOverrideEnvelope();
      const body = {
        ...env,
        confirmation_phrase: `  ${EXPECTED_RESTORE_PHRASE.toLowerCase()}  `,
      };
      const res = await authPost(ownerToken, '/api/import?override=true', body);

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('RESTORE_CONFIRMATION_MISMATCH');

      const after = await authGet(ownerToken, '/api/export');
      const post = after.json() as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
    });

    // AT-82 — happy path: matching phrase commits the atomic wipe+restore.
    it('accepts override with a matching confirmation_phrase', async () => {
      const env = buildOverrideEnvelope();
      const body = { ...env, confirmation_phrase: EXPECTED_RESTORE_PHRASE };
      try {
        const res = await authPost(ownerToken, '/api/import?override=true', body);
        expect(res.statusCode).toBe(200);

        const after = await authGet(ownerToken, '/api/export');
        const post = after.json() as ExportEnvelope;
        expect(post.customers.length).toBe(env.customers.length);
        const newIds = new Set(post.customers.map((c) => c.id));
        for (const c of env.customers) expect(newIds.has(c.id)).toBe(true);
      } finally {
        await reseedAndRelogin();
      }
    });

    // AT-82 — trim: leading/trailing whitespace around the phrase is tolerated.
    it('accepts override when confirmation_phrase has surrounding whitespace', async () => {
      const env = buildOverrideEnvelope();
      const body = { ...env, confirmation_phrase: `  ${EXPECTED_RESTORE_PHRASE}\n` };
      try {
        const res = await authPost(ownerToken, '/api/import?override=true', body);
        expect(res.statusCode).toBe(200);
      } finally {
        await reseedAndRelogin();
      }
    });

    // AT-83 — dry-run exempt: dry-run against a non-empty DB without a
    // phrase returns the preview (no writes, no enforcement).
    it('accepts dry_run without confirmation_phrase on non-empty DB', async () => {
      const env = buildOverrideEnvelope();
      const res = await authPost(ownerToken, '/api/import?override=true&dry_run=true', env);
      expect(res.statusCode).toBe(200);
      const preview = res.json() as { target_non_empty: boolean };
      expect(preview.target_non_empty).toBe(true);
    });

    // AT-83 — empty-target exempt: override into an empty DB succeeds
    // without a phrase (there is nothing to wipe).
    it('accepts override into empty DB without confirmation_phrase', async () => {
      const env = buildFreshEnvelope();
      try {
        await wipeBusinessData();
        const res = await authPost(ownerToken, '/api/import?override=true', env);
        expect(res.statusCode).toBe(200);

        const after = await authGet(ownerToken, '/api/export');
        const post = after.json() as ExportEnvelope;
        expect(post.customers.length).toBe(env.customers.length);
      } finally {
        await reseedAndRelogin();
      }
    });
  });
});
