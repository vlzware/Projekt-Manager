/**
 * Audit log integration tests — Iteration 8, issue #116.
 *
 * Pins AT-89..AT-94 from `docs/spec/verification.md §16.2` which in turn
 * pin AC-177..AC-183 / AC-187 in §15.23.
 *
 * Every `it(...)` block carries an explicit `// AT-XX` marker. Each block
 * exercises exactly one acceptance criterion — per the workflow's one-AC-
 * per-test convention and `review/conventions-tests.md` (T-REDU, T-ACBS).
 *
 * Failing-state expectations (step 3 of the workflow — tests land ahead
 * of implementation):
 *   - The `audit_log` table does not exist yet, so schema queries fail
 *     with "relation does not exist".
 *   - `GET /api/audit` and `GET /api/audit/:id` do not exist yet, so
 *     routes return 404 (Fastify's not-found handler).
 *   - The service-layer `mutate()` helper does not exist, so mutations
 *     do not produce audit rows.
 *   - No post-commit subscribe/dispatch surface exists, so AT-94 fails
 *     at the import of the expected publisher interface.
 *
 * These are the recognizable failure modes the tests intentionally
 * surface — an independent reviewer checks them in step 4 before an
 * implementation lands in step 5.
 *
 * No mocks of the database — real Postgres + real Fastify per project
 * convention (CLAUDE.md principles, integration prerequisites in
 * CONTRIBUTING.md §Testing).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { startApp, stopApp, login, authGet, authPost, authPatch } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { bootstrapAdminIfEmpty } from '../bootstrap.js';
import {
  projects as projectsTable,
  customers as customersTable,
  projectWorkers as projectWorkersTable,
  users as usersTable,
  sessions as sessionsTable,
} from '../db/schema.js';
import type { Database } from '../db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

const year = new Date().getFullYear();

/**
 * A syntactically-valid bcrypt hash for inserting stub rows where a real
 * password verification is not needed. Matches the placeholder used in
 * `bootstrap.test.ts` so the pattern is consistent across the suite.
 */
const PLACEHOLDER_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8/cN3f.y5h6N5E5hS6LXZ8kA8XwFye';

/**
 * Read every row from `audit_log`. Kept narrow and string-typed because
 * Drizzle does not yet have a schema entry for the table (the migration
 * has not landed). Raw SQL is the only cross-test-surface contract — as
 * soon as the schema ships, these helpers become a one-line switch to
 * the typed equivalent.
 */
interface AuditLogRow {
  id: string;
  created_at: Date;
  actor_id: string | null;
  actor_kind: 'user' | 'system';
  actor_reason: string | null;
  entity_type: 'project' | 'customer' | 'user' | 'project_worker';
  entity_id: string;
  action: string;
  payload: unknown;
  correlation_id: string | null;
}

/**
 * The API-facing audit-entry shape (camelCase) — `data-model.md §5.10`.
 * Used at every `res.json().data as AuditApiEntry[]` cast site. Distinct
 * from `AuditLogRow` above, which is the raw-DB shape returned by
 * `db.execute(sql\`SELECT ... FROM audit_log\`)`.
 */
interface AuditApiEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorKind: 'user' | 'system';
  actorReason: string | null;
  actorDisplayName: string | null;
  entityType: 'project' | 'customer' | 'user' | 'project_worker';
  entityId: string;
  action: string;
  payload: unknown | null;
  correlationId: string | null;
}

async function fetchAuditRows(db: Database): Promise<AuditLogRow[]> {
  const res = await db.execute(
    sql`SELECT id, created_at, actor_id, actor_kind, actor_reason,
               entity_type, entity_id, action, payload, correlation_id
        FROM audit_log
        ORDER BY created_at ASC, id ASC`,
  );
  return res.rows as unknown as AuditLogRow[];
}

async function countAuditRows(db: Database): Promise<number> {
  const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
  return (res.rows[0] as { c: number }).c;
}

// ---------------------------------------------------------------------
// AT-89 — Mutation and audit row are committed atomically (AC-177)
// ---------------------------------------------------------------------
//
// Covers the core invariant of ADR-0021: every domain-entity mutation
// emits exactly one `audit_log` row in the same transaction as the
// state change. A failure on either side aborts both.
//
// Four entity types are exercised because AC-177 names all four. They
// live in separate `it()` blocks rather than one mega-block so a
// regression in only `customer` is not masked by a passing `project`
// arm (see T-ACBS). The forced-failure branch is separate again so
// the atomic-rollback assertion does not pile onto a happy-path test.
describe('AT-89: Mutation + audit row atomicity (AC-177)', () => {
  let ownerToken: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    const customers = custList.json().customers as { id: string }[];
    if (!customers || customers.length === 0) {
      throw new Error('Seed produced no customers — cannot run AT-89 fixtures');
    }
    seededCustomerId = customers[0]!.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // AT-89 — create on `project`
  it('create on project produces exactly one audit_log row (actorKind=user, action=create)', async () => {
    const { db, pool } = createDatabase();
    try {
      const before = await countAuditRows(db);

      const createRes = await authPost(ownerToken, '/api/projects', {
        // number is varchar(20) — keep the generated string short so a
        // unique suffix still fits the schema. Uses base36 for density.
        number: `AT89C-${Date.now().toString(36)}`,
        title: 'AT-89 create project',
        customerId: seededCustomerId,
      });
      expect(createRes.statusCode).toBe(201);
      const projectId = createRes.json().id as string;

      const after = await countAuditRows(db);
      expect(after - before).toBe(1);

      const rows = await db.execute(sql`SELECT * FROM audit_log WHERE entity_id = ${projectId}`);
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0] as unknown as AuditLogRow;

      expect(row.entity_type).toBe('project');
      expect(row.action).toBe('create');
      expect(row.actor_kind).toBe('user');
      expect(row.actor_id).not.toBeNull();
      // actorReason is null for user-actor writes (data-model.md §5.10).
      expect(row.actor_reason).toBeNull();
      // Payload carries `before`/`after` — create has an empty `before`
      // and a populated `after`. Exact field contents are not pinned by
      // the AC (avoid T-BLOA); what matters is the shape.
      expect(row.payload).toMatchObject({ after: expect.any(Object) });
    } finally {
      await pool.end();
    }
  });

  // AT-89 — update on `customer`
  it('update on customer produces exactly one audit_log row (action=update)', async () => {
    const { db, pool } = createDatabase();
    try {
      const before = await countAuditRows(db);

      const patchRes = await authPatch(ownerToken, `/api/customers/${seededCustomerId}`, {
        phone: '0221-8889990',
      });
      expect(patchRes.statusCode).toBe(200);

      const after = await countAuditRows(db);
      expect(after - before).toBe(1);

      const rows = await db.execute(
        sql`SELECT * FROM audit_log
            WHERE entity_type = 'customer' AND entity_id = ${seededCustomerId}
            ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0] as unknown as AuditLogRow;
      expect(row.action).toBe('update');
      expect(row.actor_kind).toBe('user');
      // Payload diff shape: `before` and `after` both present on an
      // update (spec: "before/after of changed fields only").
      expect(row.payload).toMatchObject({
        before: expect.any(Object),
        after: expect.any(Object),
      });
    } finally {
      await pool.end();
    }
  });

  // AT-89 — transition on `project`
  it('state transition on project produces a transition-action audit row', async () => {
    const { db, pool } = createDatabase();
    try {
      // Pick a project in a non-boundary state we can advance.
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      const projectId = target!.id;

      const before = await countAuditRows(db);

      const transitionRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/transition/forward`,
        { expectedStatus: 'beauftragt' },
      );
      expect(transitionRes.statusCode).toBe(200);

      const after = await countAuditRows(db);
      expect(after - before).toBe(1);

      const rows = await db.execute(
        sql`SELECT * FROM audit_log
            WHERE entity_type = 'project' AND entity_id = ${projectId}
            ORDER BY created_at DESC LIMIT 1`,
      );
      const row = rows.rows[0] as unknown as AuditLogRow;
      // data-model.md §5.10 action vocabulary: transition rows carry
      // `transition:forward` (the colon form is pinned — changing it is
      // a deliberate schema break).
      expect(row.action).toBe('transition:forward');
      expect(row.actor_kind).toBe('user');
    } finally {
      await pool.end();
    }
  });

  // AT-89 — delete on `project_worker`
  it('delete on project_worker produces one audit_log row per dropped assignment (action=delete)', async () => {
    // Snapshot taken before the mutation so the lookup below can filter
    // by `created_at >= before`. Without this filter a sibling test (or
    // a future reorder) could leave a matching row and the lookup would
    // land on it silently.
    const before = new Date();
    const { db, pool } = createDatabase();
    try {
      // Seed: any project with a worker assignment. The seeded worker1
      // is assigned to YYYY-007 (role-scoping.test.ts mirrors this).
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const project = (list.json().data as { id: string; number: string }[]).find(
        (p) => p.number === `${year}-007`,
      );
      expect(project).toBeDefined();
      const projectId = project!.id;

      // Count the seeded assignments for this project so the delta is
      // a pinned value rather than a softened `> before`. YYYY-007 is
      // seeded with arbeiter1 + arbeiter2 (see src/server/seed/business.ts
      // ASSIGNMENT_SPECS) — two rows dropped, two audit rows emitted.
      const assignedBefore = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM project_workers WHERE project_id = ${projectId}`,
      );
      const assignedCount = (assignedBefore.rows[0] as { c: number }).c;
      expect(assignedCount).toBeGreaterThan(0);

      const auditBefore = await countAuditRows(db);

      // Update-assignments PATCH: drop the worker list to [] so the
      // service deletes existing project_worker rows. Route shape is
      // the one any reasonable implementation provides; if the final
      // implementation exposes it differently, this test fails with a
      // 404 — a recognizable implementation gap, not a silent pass.
      const patchRes = await authPatch(ownerToken, `/api/projects/${projectId}`, {
        assignedWorkerIds: [],
      });
      expect(patchRes.statusCode).toBe(200);

      const auditAfter = await countAuditRows(db);
      // Exactly `assignedCount` delete rows — one per dropped assignment,
      // per AC-177's "every mutation produces exactly one audit_log row".
      expect(auditAfter - auditBefore).toBe(assignedCount);

      const rows = await db.execute(
        sql`SELECT * FROM audit_log
            WHERE entity_type = 'project_worker' AND action = 'delete'
              AND created_at >= ${before}
              AND (payload->'before'->>'projectId' = ${projectId}
                   OR payload->'after'->>'projectId' = ${projectId})
            ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      const row = rows.rows[0] as unknown as AuditLogRow;
      expect(row.actor_kind).toBe('user');
      // `project_worker` rows carry payload referencing the project the
      // worker was attached to — used by the worker-scope predicate
      // (AC-180).
      expect(row.payload).toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  // AT-89 — forced failure path: rollback leaves neither artifact
  it('a failed mutation rolls back BOTH the state change and the audit row', async () => {
    const { db, pool } = createDatabase();
    try {
      const projectsBefore = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM projects WHERE number = 'AT-89-ROLLBACK'`,
      );
      expect((projectsBefore.rows[0] as { c: number }).c).toBe(0);

      const auditBefore = await countAuditRows(db);

      // Force an FK violation on the audited transaction: referenced
      // worker id does not exist. `data-integrity.test.ts:AT-48` pins
      // this same failure path for atomic project creation.
      const fakeWorkerId = '00000000-0000-0000-0000-000000000099';
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'AT-89-ROLLBACK',
        title: 'should never persist',
        customerId: seededCustomerId,
        assignedWorkerIds: [fakeWorkerId],
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);

      // Neither the project nor its audit row persisted.
      const projectsAfter = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM projects WHERE number = 'AT-89-ROLLBACK'`,
      );
      expect((projectsAfter.rows[0] as { c: number }).c).toBe(0);

      const auditAfter = await countAuditRows(db);
      expect(auditAfter).toBe(auditBefore);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------
// AT-90 — First-run bootstrap writes a system-actor audit row (AC-178)
// ---------------------------------------------------------------------
//
// Drives `bootstrapAdminIfEmpty` directly (same pattern as
// `bootstrap.test.ts`) against a scratch database so the resulting
// audit row can be observed in isolation. A separate assertion proves
// the DB CHECK constraint rejects a `system` row with empty
// `actorReason` — defense-in-depth for the "invisible bootstrap"
// failure mode AC-178 explicitly calls out.
describe('AT-90: Bootstrap emits system-actor audit row + CHECK constraint (AC-178)', () => {
  let db: Database;
  let pool: pg.Pool;

  function makeLogger() {
    return { warn: vi.fn(), error: vi.fn() };
  }

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Bootstrap requires an empty users table. CASCADE covers every FK
    // pointing at users (including the audit_log FK on actor_id), so
    // one statement is sufficient — two TRUNCATEs raced pre-impl when
    // audit_log did not yet exist.
    await db.execute(sql`TRUNCATE TABLE audit_log, sessions, projects, users CASCADE`);
  });

  it('bootstrap run on empty DB produces actorKind=system, null actorId, non-empty actorReason', async () => {
    const result = await bootstrapAdminIfEmpty(
      db,
      {
        username: 'admin-at-90',
        password: 'SecurePass2026!',
        displayName: 'Admin AT-90',
      },
      makeLogger(),
    );
    expect(result.inserted).toBe(true);

    const rows = await fetchAuditRows(db);
    // Exactly one row — bootstrap writes a single user-create event.
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.entity_type).toBe('user');
    expect(row.action).toBe('create');
    expect(row.actor_kind).toBe('system');
    expect(row.actor_id).toBeNull();
    // Non-empty actor_reason — this is the field that makes the
    // bootstrap visible in the Aktivität feed. AC-178 rationale.
    expect(row.actor_reason).toBeTruthy();
    expect((row.actor_reason ?? '').length).toBeGreaterThan(0);
    // A recognisable cue naming the code path, per data-model.md §5.10:
    // `"first-run-bootstrap"` is the spec's example. Regex rather than
    // equality so trivial wording drift doesn't break the test — the
    // assertion is "the reason names the bootstrap path".
    expect(row.actor_reason).toMatch(/bootstrap/i);
  });

  it('DB CHECK constraint rejects a system audit row with null actorReason', async () => {
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO audit_log
           (actor_id, actor_kind, actor_reason, entity_type, entity_id, action, payload)
         VALUES (NULL, 'system', NULL, 'user',
                 '00000000-0000-0000-0000-000000000001', 'create', '{}'::jsonb)`,
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }
    expect(pgError).not.toBeNull();
    // 23514 = check_violation. Pinning the code lets us distinguish a
    // CHECK rejection from a NOT NULL / type error / trigger.
    expect(pgError!.code).toBe('23514');
  });

  it('DB CHECK constraint rejects a system audit row with empty-string actorReason', async () => {
    let pgError: { code?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO audit_log
           (actor_id, actor_kind, actor_reason, entity_type, entity_id, action, payload)
         VALUES (NULL, 'system', '', 'user',
                 '00000000-0000-0000-0000-000000000001', 'create', '{}'::jsonb)`,
      );
    } catch (err) {
      pgError = err as { code?: string };
    }
    expect(pgError).not.toBeNull();
    expect(pgError!.code).toBe('23514');
  });
});

// ---------------------------------------------------------------------
// AT-91 — Worker-scoped list endpoint (AC-180)
// ---------------------------------------------------------------------
//
// Seed already populates the assignment graph (worker1 → YYYY-007,
// 008, 009, 011 per role-scoping.test.ts). We layer audit rows on top
// of the seed so the list response has something non-empty to scope.
//
// Owner and office are unscoped and receive every row — a positive
// regression against the same audit-scope predicate.
describe('AT-91: Worker-scoped GET /api/audit list (AC-180)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let workerId: string;
  // Reachability sets derived from raw SQL (not via authGet) so the
  // oracle does not share the ADR-0019 scoping predicate with the SUT
  // — a uniform bug in the predicate must not silently pass.
  let workerAssignedProjectIds: Set<string>;
  let workerReachableCustomerIds: Set<string>;
  // Audit-row id for the owner's self-PATCH (entityType='user',
  // actorId=ownerId). Used as a positive control in the owner/office
  // unscoped blocks: asserting presence rules out a buggy predicate
  // that returns only one seeded row.
  let ownerAuthoredUserRowId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
    ]);

    const workerMeRes = await authGet(workerToken, '/api/auth/me');
    expect(workerMeRes.statusCode).toBe(200);
    // GET /api/auth/me envelopes the profile as `{ user: { id, ... } }`
    // (api.md §14.2.1). The earlier draft did `.json().id` and got
    // `undefined` back, which made the AC-180 assertion trivially fail
    // on every worker-visible user row. Drill one level in so workerId
    // is the caller's real uuid.
    workerId = workerMeRes.json().user.id as string;

    // Mutations that write audit rows covering every entity_type the
    // scoping predicate cares about:
    //   - project (assigned + unassigned)
    //   - customer (reachable + unreachable via worker1's assignments)
    //   - project_worker (assigned project)
    //   - user (two rows: one authored by the owner — not self-authored
    //     for the worker, thus hidden; one authored by the worker —
    //     self-authored under AC-180's self-authorship clause, thus
    //     visible in the worker's own feed)

    // Update on an assigned project → audit row for `project` entity_type,
    // reachable via worker1's assignment.
    const projects = (await authGet(ownerToken, '/api/projects?limit=200')).json().data as {
      id: string;
      number: string;
      customerId: string;
    }[];
    const assigned = projects.find((p) => p.number === `${year}-007`);
    const unassigned = projects.find((p) => p.number === `${year}-001`);
    expect(assigned).toBeDefined();
    expect(unassigned).toBeDefined();

    await authPatch(ownerToken, `/api/projects/${assigned!.id}`, {
      notes: 'AT-91 update assigned',
    });
    await authPatch(ownerToken, `/api/projects/${unassigned!.id}`, {
      notes: 'AT-91 update unassigned',
    });

    // Update on the assigned project's customer → audit row for
    // `customer` entity_type, reachable via the worker's assignment.
    await authPatch(ownerToken, `/api/customers/${assigned!.customerId}`, {
      notes: 'AT-91 update reachable customer',
    });
    // Update on an unreachable customer (the unassigned project's).
    await authPatch(ownerToken, `/api/customers/${unassigned!.customerId}`, {
      notes: 'AT-91 update unreachable customer',
    });

    // Owner-authored user-entity row → worker must NOT see it
    // (AC-180: self-authorship clause requires actor_id == caller.id).
    // Route is PATCH /api/auth/me (see src/server/routes/auth.ts);
    // asserting the 200 so a route rename surfaces here rather than
    // silently dropping the row and turning AC-180's negative half
    // into a tautology.
    const ownerSelfPatch = await authPatch(ownerToken, `/api/auth/me`, {
      themePreference: 'dark',
    });
    expect(ownerSelfPatch.statusCode).toBe(200);

    // Worker-authored user-entity row → worker MUST see it
    // (AC-180: self-authorship clause admits entityType='user' rows
    // where actor_id == caller.id). Same route as above, different
    // caller.
    const workerSelfPatch = await authPatch(workerToken, `/api/auth/me`, {
      themePreference: 'dark',
    });
    expect(workerSelfPatch.statusCode).toBe(200);

    // Drive a project_worker assignment change on an unassigned
    // project. The resulting audit row for entityType='project_worker'
    // references a project the worker is NOT assigned to (the target
    // project), so the reachability predicate must exclude it from
    // the worker's view.
    const workerList = (await authGet(ownerToken, '/api/users?limit=200')).json().users as {
      id: string;
      username: string;
    }[];
    const worker2 = workerList.find((u) => u.username === SEED_USERS.worker2.username);
    expect(worker2).toBeDefined();
    if (worker2) {
      await authPatch(ownerToken, `/api/projects/${unassigned!.id}`, {
        assignedWorkerIds: [worker2.id],
      });
    }

    // Derive the worker's reachability sets from raw SQL rather than the
    // scoped endpoints. authGet('/api/projects'), authGet('/api/customers')
    // run the same ADR-0019 predicate under test; using them as the oracle
    // would let a uniform predicate bug pass silently. Owner-side lookups
    // of the acting ids are unscoped and safe to derive via raw SQL.
    const { db: fixtureDb, pool: fixturePool } = createDatabase();
    try {
      const assignedRows = await fixtureDb.execute(
        sql`SELECT project_id FROM project_workers WHERE user_id = ${workerId}`,
      );
      workerAssignedProjectIds = new Set(
        (assignedRows.rows as { project_id: string }[]).map((r) => r.project_id),
      );

      // Subquery on `project_workers` rather than passing the JS Set as a
      // `= ANY(...)` parameter — drizzle's sql template inlines a JS array
      // as a parenthesized tuple, which Postgres rejects with
      // "op ANY/ALL (array) requires array on right side".
      const customerRows = await fixtureDb.execute(
        sql`SELECT DISTINCT customer_id FROM projects
            WHERE id IN (SELECT project_id FROM project_workers WHERE user_id = ${workerId})`,
      );
      workerReachableCustomerIds = new Set(
        (customerRows.rows as { customer_id: string }[]).map((r) => r.customer_id),
      );

      // Capture the audit-row id for the owner's self-PATCH: the most
      // recent entity_type='user' row authored by the owner. Unscoped
      // (raw SQL) — we're asking "what did the DB record?", not "what
      // does the predicate return?".
      const ownerLookup = await fixtureDb.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      const ownerRow = ownerLookup.rows[0] as { id: string } | undefined;
      if (!ownerRow) {
        throw new Error('AT-91 fixture: owner user missing from seed');
      }
      const ownerAuditLookup = await fixtureDb.execute(
        sql`SELECT id FROM audit_log
            WHERE entity_type = 'user' AND actor_id = ${ownerRow.id}
            ORDER BY created_at DESC LIMIT 1`,
      );
      const ownerAuditRow = ownerAuditLookup.rows[0] as { id: string } | undefined;
      if (!ownerAuditRow) {
        throw new Error(
          'AT-91 fixture: no owner-authored user audit row — owner self-PATCH did not emit one',
        );
      }
      ownerAuthoredUserRowId = ownerAuditRow.id;
    } finally {
      await fixturePool.end();
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  // AT-91 — worker scope: list admits only reachable rows plus
  // self-authored user rows
  it('worker receives only rows reachable via assignments plus self-authored user rows', async () => {
    const res = await authGet(workerToken, '/api/audit?limit=500');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const entries = body.data as AuditApiEntry[];

    // AC-180 self-authorship clause: any `user`-entity row the worker
    // sees must be authored by the worker themselves. The owner's
    // theme-preference PATCH (see beforeAll) produces a user row with
    // actorId === owner — it must NOT appear here.
    for (const row of entries) {
      if (row.entityType === 'user') {
        expect(row.actorId).toBe(workerId);
      }
    }

    // Positive half of the self-authorship clause: the worker's own
    // PATCH /api/auth/me (see beforeAll) produced a user-entity row
    // the worker MUST see in their own feed. Without this assertion
    // the negative half above would trivially pass on an empty
    // user-entity slice.
    const selfAuthoredUserRows = entries.filter(
      (row) => row.entityType === 'user' && row.actorId === workerId,
    );
    expect(selfAuthoredUserRows.length).toBeGreaterThanOrEqual(1);

    // api.md §14.2.8 boundary-stripping: on every non-self-authored row
    // visible to a worker, both `actorId` and `payload` must be null at
    // the API boundary. Self-authored rows (actorId === workerId) keep
    // full detail; everything else is stripped.
    for (const row of entries) {
      if (row.actorId !== workerId) {
        expect(row.actorId).toBeNull();
        expect(row.payload).toBeNull();
      }
    }

    // Every `project` entry the worker sees is for an assigned project.
    // Oracle is derived from raw SQL in beforeAll (workerAssignedProjectIds)
    // to avoid sharing the ADR-0019 scoping predicate with the SUT.
    for (const row of entries) {
      if (row.entityType === 'project') {
        expect(workerAssignedProjectIds.has(row.entityId)).toBe(true);
      }
    }

    // Every `customer` entry is for a customer reachable via an
    // assigned project. Oracle is derived from raw SQL in beforeAll
    // (workerReachableCustomerIds).
    for (const row of entries) {
      if (row.entityType === 'customer') {
        expect(workerReachableCustomerIds.has(row.entityId)).toBe(true);
      }
    }

    // Every `project_worker` entry's payload references a project
    // the worker is assigned to. Payload shape per data-model.md
    // §5.10 carries before/after with projectId/userId; the
    // reachability predicate pins the projectId to the caller's
    // assignment set (AC-180).
    //
    // Worker boundary-stripping (api.md §14.2.8): for non-self-authored
    // rows the API returns payload=null, so we can only assert a
    // projectId match on self-authored project_worker rows. The scope
    // guarantee for the stripped rows is "this row exists in the
    // worker's feed only because its payload projectId was in the
    // assignment set at read time" — implicit via the stripped-row
    // count being non-negative rather than verifiable here.
    for (const row of entries) {
      if (row.entityType === 'project_worker' && row.actorId === workerId) {
        const payload = row.payload as
          | { before?: { projectId?: string }; after?: { projectId?: string } }
          | null
          | undefined;
        const projectId = payload?.after?.projectId ?? payload?.before?.projectId;
        if (projectId === undefined) {
          throw new Error(
            `AT-91: project_worker audit row ${row.id} has no projectId in payload — reachability predicate cannot have admitted it (got payload ${JSON.stringify(row.payload)})`,
          );
        }
        expect(workerAssignedProjectIds.has(projectId)).toBe(true);
      }
    }
  });

  // AT-91 — owner: unscoped
  it('owner receives every audit row (no scope predicate)', async () => {
    const res = await authGet(ownerToken, '/api/audit?limit=500');
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];

    // Owner sees `user`-entity rows — at minimum the self-update above.
    const hasUserEntry = entries.some((row) => row.entityType === 'user');
    expect(hasUserEntry).toBe(true);

    // Positive control: the owner-authored user row must be present.
    // `some(entityType==='user')` alone would pass on a buggy predicate
    // returning only one unrelated seeded row.
    const ids = new Set(entries.map((row) => row.id));
    expect(ids.has(ownerAuthoredUserRowId)).toBe(true);
  });

  // AT-91 — office: unscoped
  it('office receives every audit row (no scope predicate)', async () => {
    const res = await authGet(officeToken, '/api/audit?limit=500');
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];
    const hasUserEntry = entries.some((row) => row.entityType === 'user');
    expect(hasUserEntry).toBe(true);

    // Positive control: the owner-authored user row must be present for
    // office too — office reachability is null (unscoped), and the
    // destructive predicate excludes roles-diff updates only (api.md
    // §14.2.8). A theme-preference update touches no roles, so it's
    // admitted.
    const ids = new Set(entries.map((row) => row.id));
    expect(ids.has(ownerAuthoredUserRowId)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// AT-92 — Worker GET /api/audit/:id three-way result (AC-181)
// ---------------------------------------------------------------------
//
// Mirrors the AC-147 pattern pinned in `role-scoping.test.ts` for
// projects. The three outcomes (200 / 403 / 404) must be distinguishable
// at the caller boundary — collapsing 403 into 404 leaks existence via
// absence and is explicitly forbidden by the spec.
describe('AT-92: Worker GET /api/audit/:id 200/403/404 (AC-181)', () => {
  let ownerToken: string;
  let workerToken: string;
  let inScopeAuditId: string;
  let outOfScopeAuditId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, workerToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
    ]);

    const projects = (await authGet(ownerToken, '/api/projects?limit=200')).json().data as {
      id: string;
      number: string;
    }[];
    const assigned = projects.find((p) => p.number === `${year}-007`)!;
    const unassigned = projects.find((p) => p.number === `${year}-001`)!;

    // Drive one update on each so there's a fresh audit row on both sides.
    await authPatch(ownerToken, `/api/projects/${assigned.id}`, {
      notes: `AT-92 in-scope ${Date.now()}`,
    });
    await authPatch(ownerToken, `/api/projects/${unassigned.id}`, {
      notes: `AT-92 out-of-scope ${Date.now()}`,
    });

    // Owner list is unscoped, so it contains both; find the latest for
    // each project. Pre-impl the endpoint 404s — convert that into an
    // explicit failure with a recognizable message instead of letting
    // `undefined.find(...)` crash with a TypeError in beforeAll.
    const auditList = await authGet(ownerToken, '/api/audit?limit=500');
    if (auditList.statusCode !== 200) {
      throw new Error(
        `AT-92 fixture: GET /api/audit expected 200, got ${auditList.statusCode} — audit endpoint likely missing`,
      );
    }
    const entries = ((auditList.json() as { data?: AuditApiEntry[] }).data ??
      []) as AuditApiEntry[];
    const inScope = entries.find(
      (row) => row.entityType === 'project' && row.entityId === assigned.id,
    );
    const outOfScope = entries.find(
      (row) => row.entityType === 'project' && row.entityId === unassigned.id,
    );
    if (!inScope || !outOfScope) {
      throw new Error('AT-92 fixture missing — expected audit rows for both projects');
    }
    inScopeAuditId = inScope.id;
    outOfScopeAuditId = outOfScope.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  it('worker receives 200 for an in-scope audit entry', async () => {
    const res = await authGet(workerToken, `/api/audit/${inScopeAuditId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(inScopeAuditId);
  });

  it('worker receives 403 NOT_PERMITTED for an existing out-of-scope entry', async () => {
    const res = await authGet(workerToken, `/api/audit/${outOfScopeAuditId}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });

  it('worker receives 404 NOT_FOUND for a non-existent id', async () => {
    const res = await authGet(workerToken, '/api/audit/00000000-0000-0000-0000-000000000000');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------
// AT-93 — Destructive-action predicate gates visibility (AC-182, AC-187)
// ---------------------------------------------------------------------
//
// `auditDestructiveScopeForCaller` narrows the list + get-by-id result
// set. For owner (default matrix) the predicate returns null — owner
// sees every row, including destructive ones. For every other role
// holding `audit:read`, the predicate contributes a `WHERE` fragment
// that excludes entries matching: action=purge (any entity type),
// action=delete on user, action=update on user touching `roles`.
//
// Fixture strategy: seed the three destructive rows directly via raw
// SQL against `audit_log`. This test file is in the `__tests__/`
// allowlist per AC-179, and the direct-insert path is the same one
// `audit-retention.test.ts` uses for the retention fixture.
//
// Rationale for the raw-SQL fixture over API-driven mutations (the
// earlier draft used `POST /api/projects` + `DELETE /api/projects/:id`
// + `DELETE /api/projects/:id/purge` + `DELETE /api/users/:id` +
// `PATCH /api/users/:id`): pre-implementation those routes return 500
// because the service layer attempts to write audit rows that don't
// exist, making the whole describe crash in `beforeAll` with an
// unrecognizable failure shape ("500 from failed audit write") instead
// of the intended "endpoint missing on /api/audit". The raw-SQL
// fixture keeps AT-93 **independent of the mutation pipeline** — the
// test proves the read-side destructive-scope predicate without
// depending on the not-yet-implemented write-side helper. Mutation-
// pipeline coverage (atomic-commit, rollback) is pinned separately by
// AT-89; AT-93's scope is the visibility predicate.
describe('AT-93: Destructive-action visibility (AC-182, AC-187)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  /** An audit row matching `action='purge'` — owner-visible, others hidden. */
  let purgeAuditId: string;
  /** An audit row matching `action='delete'` on `entityType='user'`. */
  let userDeleteAuditId: string;
  /** An audit row matching `action='update'` on `entityType='user'` touching roles. */
  let userRolesUpdateAuditId: string;
  /**
   * Negative-control row: `action='update'` on `entityType='user'` whose
   * diff is email-only (no `roles`). Owner and office MUST see it — it
   * is not destructive. The purpose is to prove the destructive
   * predicate keys specifically off the `roles` diff rather than any
   * broader "user entity update" catch-all.
   */
  let userEmailUpdateAuditId: string;
  /**
   * An in-scope non-destructive audit row visible to worker1 —
   * positive control for the worker list block. Without it, an endpoint
   * returning `[]` to workers would pass the `!ids.has(purgeAuditId)`
   * assertion trivially.
   */
  let workerVisibleNonDestructiveId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
    ]);

    // Use a fresh DB/pool handle for the raw inserts so it is torn down
    // before `stopApp`. Drizzle's `sql` template does parameter binding
    // via positional placeholders — safe with arbitrary string input.
    const { db: fixtureDb, pool: fixturePool } = createDatabase();
    try {
      // Resolve an owner user id — the user-actor destructive rows must
      // cite a real UserAccount row because `actor_id` is a FK to users.
      // Owner is guaranteed to exist (seeded in every test env).
      const ownerLookup = await fixtureDb.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      const ownerRow = ownerLookup.rows[0] as { id: string } | undefined;
      if (!ownerRow) {
        throw new Error('AT-93 fixture: owner user missing from seed');
      }
      const ownerId = ownerRow.id;

      // ---- Purge row — entity_type='project', action='purge' ----
      // Payload shape per data-model.md §5.10: `after` empty on delete/
      // purge. The `entityId` cites a synthetic project uuid: `entityId`
      // is not FK-constrained (purge removes the target row while its
      // audit trail remains).
      const purgeEntityId = '00000000-0000-0000-0000-0000000a7931';
      const purgeInsert = await fixtureDb.execute(sql`
        INSERT INTO audit_log
          (actor_id, actor_kind, actor_reason, entity_type, entity_id,
           action, payload, correlation_id)
        VALUES (${ownerId}, 'user', NULL, 'project', ${purgeEntityId},
                'purge', '{"before":{"number":"AT-93-PURGE"},"after":{}}'::jsonb, NULL)
        RETURNING id
      `);
      purgeAuditId = (purgeInsert.rows[0] as { id: string }).id;

      // ---- User-delete row — entity_type='user', action='delete' ----
      const userDeleteEntityId = '00000000-0000-0000-0000-0000000a7932';
      const userDeleteInsert = await fixtureDb.execute(sql`
        INSERT INTO audit_log
          (actor_id, actor_kind, actor_reason, entity_type, entity_id,
           action, payload, correlation_id)
        VALUES (${ownerId}, 'user', NULL, 'user', ${userDeleteEntityId},
                'delete',
                '{"before":{"username":"at93_hard_delete"},"after":{}}'::jsonb,
                NULL)
        RETURNING id
      `);
      userDeleteAuditId = (userDeleteInsert.rows[0] as { id: string }).id;

      // ---- User-roles-update row ----
      // Payload carries `{ before: { roles: [...] }, after: { roles: [...] } }`
      // as per the AT-93 fixture spec — the predicate keys off the
      // `roles` diff presence.
      const rolesUpdateEntityId = '00000000-0000-0000-0000-0000000a7933';
      const rolesUpdateInsert = await fixtureDb.execute(sql`
        INSERT INTO audit_log
          (actor_id, actor_kind, actor_reason, entity_type, entity_id,
           action, payload, correlation_id)
        VALUES (${ownerId}, 'user', NULL, 'user', ${rolesUpdateEntityId},
                'update',
                '{"before":{"roles":["office"]},"after":{"roles":["worker"]}}'::jsonb,
                NULL)
        RETURNING id
      `);
      userRolesUpdateAuditId = (rolesUpdateInsert.rows[0] as { id: string }).id;

      // ---- Negative control — user-email-update (no `roles` diff) ----
      // Proves the destructive predicate keys specifically off the
      // `roles` diff: a user-entity update whose diff omits `roles` is
      // NOT destructive. Owner and office must both see it (office is
      // unscoped on reachability per api.md §14.2.8; the destructive
      // predicate admits this row because the diff does not touch roles).
      const emailUpdateEntityId = '00000000-0000-0000-0000-0000000a7934';
      const emailUpdateInsert = await fixtureDb.execute(sql`
        INSERT INTO audit_log
          (actor_id, actor_kind, actor_reason, entity_type, entity_id,
           action, payload, correlation_id)
        VALUES (${ownerId}, 'user', NULL, 'user', ${emailUpdateEntityId},
                'update',
                '{"before":{"email":"old@example.com"},"after":{"email":"new@example.com"}}'::jsonb,
                NULL)
        RETURNING id
      `);
      userEmailUpdateAuditId = (emailUpdateInsert.rows[0] as { id: string }).id;

      // ---- Worker positive-control — in-scope non-destructive row ----
      // Drive an `update` mutation against a worker-assigned project so
      // the worker's reachability predicate admits the resulting audit
      // row. Without this, the worker block would only have a negative
      // assertion (purge absence) and an endpoint returning `[]` would
      // pass silently. YYYY-007 is assigned to worker1 (see
      // role-scoping.test.ts fixtures).
      const workerProjects = (await authGet(ownerToken, '/api/projects?limit=200')).json().data as {
        id: string;
        number: string;
      }[];
      const workerAssignedProject = workerProjects.find((p) => p.number === `${year}-007`);
      if (!workerAssignedProject) {
        throw new Error('AT-93 fixture: expected YYYY-007 in seed for worker positive control');
      }
      const auditBefore = await fixtureDb.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log
            WHERE entity_type = 'project' AND action = 'update'
              AND entity_id = ${workerAssignedProject.id}`,
      );
      const beforeCount = (auditBefore.rows[0] as { c: number }).c;
      const patchRes = await authPatch(ownerToken, `/api/projects/${workerAssignedProject.id}`, {
        notes: `AT-93 worker positive control ${Date.now()}`,
      });
      if (patchRes.statusCode !== 200) {
        throw new Error(
          `AT-93 fixture: expected 200 from worker-visible update, got ${patchRes.statusCode}`,
        );
      }
      const auditAfter = await fixtureDb.execute(
        sql`SELECT id FROM audit_log
            WHERE entity_type = 'project' AND action = 'update'
              AND entity_id = ${workerAssignedProject.id}
            ORDER BY created_at DESC LIMIT 1`,
      );
      if (auditAfter.rows.length === 0) {
        throw new Error('AT-93 fixture: worker-visible update produced no audit row');
      }
      const auditAfterCount = await fixtureDb.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log
            WHERE entity_type = 'project' AND action = 'update'
              AND entity_id = ${workerAssignedProject.id}`,
      );
      expect((auditAfterCount.rows[0] as { c: number }).c).toBe(beforeCount + 1);
      workerVisibleNonDestructiveId = (auditAfter.rows[0] as { id: string }).id;
    } finally {
      await fixturePool.end();
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  it('owner list includes purge, user-delete, and user-roles-update rows', async () => {
    const res = await authGet(ownerToken, '/api/audit?limit=1000');
    expect(res.statusCode).toBe(200);
    const ids = new Set((res.json().data as AuditApiEntry[]).map((r) => r.id));
    expect(ids.has(purgeAuditId)).toBe(true);
    expect(ids.has(userDeleteAuditId)).toBe(true);
    expect(ids.has(userRolesUpdateAuditId)).toBe(true);
    // Negative control: the non-destructive email-update row must be
    // present. Owner sees everything; this pins that AND the predicate
    // is keying off the `roles` diff rather than any broader catch-all.
    expect(ids.has(userEmailUpdateAuditId)).toBe(true);
  });

  it('office list excludes all three destructive entries (predicate WHERE fragment)', async () => {
    const res = await authGet(officeToken, '/api/audit?limit=1000');
    expect(res.statusCode).toBe(200);
    const ids = new Set((res.json().data as AuditApiEntry[]).map((r) => r.id));
    expect(ids.has(purgeAuditId)).toBe(false);
    expect(ids.has(userDeleteAuditId)).toBe(false);
    expect(ids.has(userRolesUpdateAuditId)).toBe(false);
    // Negative control: the email-update row has no `roles` diff and is
    // therefore NOT destructive. Office reachability is null (unscoped
    // per api.md §14.2.8), so the row must be admitted — proving the
    // destructive predicate keys off `roles` specifically, not any
    // user-entity update.
    expect(ids.has(userEmailUpdateAuditId)).toBe(true);
  });

  it('worker list excludes the purge row (worker also excluded from user rows via reachability)', async () => {
    const res = await authGet(workerToken, '/api/audit?limit=1000');
    expect(res.statusCode).toBe(200);
    const ids = new Set((res.json().data as AuditApiEntry[]).map((r) => r.id));
    // Positive control: a reachable non-destructive row must be present
    // in the worker's feed. Without this, an endpoint returning `[]`
    // would pass the purge-absence assertion trivially.
    expect(ids.has(workerVisibleNonDestructiveId)).toBe(true);
    // Purge carries `entityType='project'` — the reachability predicate
    // alone does NOT exclude every purge (only unreachable ones); the
    // destructive predicate is what excludes them categorically.
    // This is the assertion AC-182/AC-187 pins.
    expect(ids.has(purgeAuditId)).toBe(false);
  });

  it('office get-by-id on a purge row returns 403 NOT_PERMITTED', async () => {
    const res = await authGet(officeToken, `/api/audit/${purgeAuditId}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });

  it('office get-by-id on a user-delete row returns 403 NOT_PERMITTED', async () => {
    const res = await authGet(officeToken, `/api/audit/${userDeleteAuditId}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });

  it('office get-by-id on a user-roles-update row returns 403 NOT_PERMITTED', async () => {
    const res = await authGet(officeToken, `/api/audit/${userRolesUpdateAuditId}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });
});

// ---------------------------------------------------------------------
// AT-94 — Throwing post-commit subscriber does not roll back (AC-183)
// ---------------------------------------------------------------------
//
// ADR-0021 fixes the publisher as post-commit: subscribers run after
// the domain transaction has committed, so a throwing subscriber
// cannot undo the state change or the audit row.
//
// The publisher/subscriber surface does not exist yet. This test
// imports the expected module path and will fail at import time until
// the implementation lands — that's the recognizable failing state
// for step 3.
describe('AT-94: Throwing post-commit subscriber does not roll back (AC-183)', () => {
  let ownerToken: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    seededCustomerId = (custList.json().customers as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  it('a subscriber that throws leaves the mutation and audit row committed and surfaces the error in the operational logger', async () => {
    // Import the publisher surface spec'd in api.md §14.2.8
    // (`Post-commit publisher contract`). Until the module exists this
    // throws MODULE_NOT_FOUND at runtime — the recognizable failing
    // state step 3 wants. The `/* @vite-ignore */` comment and the
    // string-literal path mirror the pattern in `seed.test.ts` (AT-87)
    // so the dynamic import does not compile-fail `tsc --noEmit` in
    // CI's type-check step — failure surface stays a runtime error,
    // not a type error.
    const publisherPath = '../services/audit-publisher.js';
    const pub = await import(/* @vite-ignore */ publisherPath);

    // The subscriber surface — `onAuditCommitted(handler)` returning
    // an unsubscribe function, and `setOperationalLogger(logger)` for
    // test-side injection — is pinned by api.md §14.2.8.
    const errorSpy = vi.fn();
    const fakeLogger = {
      info: vi.fn(),
      error: errorSpy,
    };

    (pub as { setOperationalLogger: (l: unknown) => void }).setOperationalLogger(fakeLogger);

    const unsubscribe = (
      pub as {
        onAuditCommitted: (h: (row: unknown) => void | Promise<void>) => () => void;
      }
    ).onAuditCommitted(() => {
      throw new Error('AT-94 intentional subscriber failure');
    });

    try {
      const { db, pool } = createDatabase();
      try {
        const auditBefore = await countAuditRows(db);

        const createRes = await authPost(ownerToken, '/api/projects', {
          // number is varchar(20); base36 keeps the generated suffix short.
          number: `AT94-${Date.now().toString(36)}`,
          title: 'AT-94 subscriber crash test',
          customerId: seededCustomerId,
        });
        // Domain mutation must succeed despite the subscriber crash
        // — this is the AC-183 invariant.
        expect(createRes.statusCode).toBe(201);
        const projectId = createRes.json().id as string;

        // State change is committed.
        const project = await db.execute(sql`SELECT id FROM projects WHERE id = ${projectId}`);
        expect(project.rows).toHaveLength(1);

        // Audit row is committed.
        const auditAfter = await countAuditRows(db);
        expect(auditAfter - auditBefore).toBe(1);

        // Subscriber error surfaces via the structured operational
        // logger. AC-183 pins the concrete field set on the log line:
        //   - event = 'audit-publisher-handler-error'
        //   - audit_entry_id — the committed row's id (non-empty)
        //   - error_message — a non-empty string
        //
        // Two common logger conventions exist:
        //   a) `logger.error({ event, audit_entry_id, error_message })`
        //   b) `logger.error('message', { event, audit_entry_id, error_message })`
        // We scan all `errorSpy` calls for the first whose object-arg
        // carries the expected `event` — using `calls[0]` would blame
        // this test for an unrelated earlier `.error(...)` call landing
        // first. The contract is the field-set, not the call ordinal.
        expect(errorSpy).toHaveBeenCalled();
        let payload: Record<string, unknown> | undefined;
        for (const call of errorSpy.mock.calls) {
          const objectArg = (call as unknown[]).find(
            (arg): arg is Record<string, unknown> =>
              typeof arg === 'object' && arg !== null && !Array.isArray(arg),
          );
          if (objectArg && objectArg.event === 'audit-publisher-handler-error') {
            payload = objectArg;
            break;
          }
        }
        if (!payload) {
          throw new Error(
            `AT-94: no logger.error call with event='audit-publisher-handler-error' found — got calls ${JSON.stringify(errorSpy.mock.calls)}`,
          );
        }
        expect(payload.event).toBe('audit-publisher-handler-error');
        expect(typeof payload.audit_entry_id).toBe('string');
        expect((payload.audit_entry_id as string).length).toBeGreaterThan(0);
        expect(typeof payload.error_message).toBe('string');
        expect((payload.error_message as string).length).toBeGreaterThan(0);
      } finally {
        await pool.end();
      }
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------
// Housekeeping — defensive cleanup of test-created users/customers.
//
// The outer `startApp()` / `stopApp()` pair in each `describe` block
// already re-seeds per-file (vitest.config.ts fileParallelism:false +
// api-helpers.ts seed(force:true)), so cross-test contamination is
// not a concern. This block exists only to document that choice — no
// inter-file fixture handoff is required.
// ---------------------------------------------------------------------
void [
  // Reference imported symbols so TS doesn't mark them as unused when
  // a future maintainer trims one of the sub-describes.
  and,
  eq,
  projectsTable,
  customersTable,
  projectWorkersTable,
  usersTable,
  sessionsTable,
  PLACEHOLDER_HASH,
];
