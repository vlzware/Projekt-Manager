/**
 * Data integrity tests — AC-94 through AC-99.
 *
 * Verifies defense-in-depth constraints identified by the data integrity
 * audit: optimistic locking on transitions, soft-delete immutability,
 * DB-level CHECK constraints, FK integrity on audit columns, and atomic
 * project creation.
 *
 * AT-42 to AT-48 (verification.md §16.2).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db/connection.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../seed.js';
import { eq } from 'drizzle-orm';
import { projects, customers } from '../db/schema.js';
import type { Database } from '../db/connection.js';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  authDelete,
} from '../../test/api-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

// ---------------------------------------------------------------
// §15.18 AC-95: Soft-deleted projects are immutable via API
// AT-42, AT-43, AT-44
// ---------------------------------------------------------------
describe('AC-95: Mutations on soft-deleted projects', () => {
  let token: string;
  let deletedProjectId: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');

    // Find a project that can be soft-deleted
    const listRes = await authGet(token, '/api/projects');
    const projectList = listRes.json().data;
    // Pick a project in a non-terminal state that we can sacrifice
    const target = projectList.find((p: Record<string, unknown>) => p.status === 'angebot');
    expect(target).toBeDefined();
    deletedProjectId = target.id;

    // Soft-delete it
    const delRes = await authDelete(token, `/api/projects/${deletedProjectId}`);
    expect(delRes.statusCode).toBe(200);

    // Confirm it's gone from list results
    const after = await authGet(token, `/api/projects/${deletedProjectId}`);
    expect(after.statusCode).toBe(404);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AT-42: transition on a soft-deleted project returns 404', async () => {
    const res = await authPost(token, `/api/projects/${deletedProjectId}/transition/forward`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('AT-42: backward transition on a soft-deleted project returns 404', async () => {
    const res = await authPost(token, `/api/projects/${deletedProjectId}/transition/backward`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('AT-43: date update on a soft-deleted project returns 404', async () => {
    const res = await authPatch(token, `/api/projects/${deletedProjectId}/dates`, {
      plannedStart: '2026-09-01',
      plannedEnd: '2026-09-15',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('AT-44: PATCH update on a soft-deleted project returns 404', async () => {
    const res = await authPatch(token, `/api/projects/${deletedProjectId}`, {
      title: 'Should Not Work',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------
// §15.18 AC-94: Concurrent state transitions are rejected as conflict
// AT-49
// ---------------------------------------------------------------
describe('AC-94: Concurrent state transitions', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AT-49: two concurrent forward transitions — one succeeds, one is rejected as conflict', async () => {
    // Pick a project in a non-terminal, non-boundary state.
    // Seed (data-model.md §7.1) provides 2 projects in 'beauftragt'.
    const listRes = await authGet(token, '/api/projects');
    const projectList = listRes.json().data;
    const target = projectList.find((p: Record<string, unknown>) => p.status === 'beauftragt');
    expect(target).toBeDefined();
    const projectId = target.id;

    // Fire two concurrent forward transitions on the same project.
    // The optimistic lock at project-transitions.ts:60 (WHERE status = :before)
    // ensures the second UPDATE matches 0 rows once the first commits.
    const [resA, resB] = await Promise.all([
      authPost(token, `/api/projects/${projectId}/transition/forward`),
      authPost(token, `/api/projects/${projectId}/transition/forward`),
    ]);

    // Exactly one must succeed (200), the other must conflict (409).
    const codes = [resA.statusCode, resB.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    // The conflict response must use the CONFLICT error code
    // (api.md §14.4.1).
    const conflict = resA.statusCode === 409 ? resA : resB;
    expect(conflict.json().code).toBe('CONFLICT');

    // The project must have advanced exactly ONE step, not two.
    const verifyRes = await authGet(token, `/api/projects/${projectId}`);
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().status).toBe('geplant');
  });
});

// ---------------------------------------------------------------
// §15.18 AC-96, AC-97: DB-level CHECK constraints
// AT-45, AT-46
// ---------------------------------------------------------------
describe('AC-96/AC-97: DB CHECK constraints', () => {
  let db: Database;
  let pool: pg.Pool;
  let testCustomerId: string;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    const rows = await db
      .insert(customers)
      .values({ name: 'Integrity Test Kunde' })
      .returning({ id: customers.id });
    testCustomerId = rows[0]!.id;
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.customerId, testCustomerId));
    await db.delete(customers).where(eq(customers.id, testCustomerId));
    await pool.end();
  });

  it('AT-45: rejects INSERT with invalid status value', async () => {
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO projects (number, title, customer_id, status)
         VALUES ($1, $2, $3, $4)`,
        ['CHK-STAT-01', 'invalid status', testCustomerId, 'nonexistent_state'],
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }

    expect(pgError).not.toBeNull();
    expect(pgError!.code).toBe('23514'); // check_violation
    expect(pgError!.constraint).toBe('projects_valid_status');
  });

  it('AT-45: accepts all valid status values', async () => {
    const validStates = [
      'anfrage',
      'angebot',
      'beauftragt',
      'geplant',
      'in_arbeit',
      'abnahme',
      'rechnung_faellig',
      'abgerechnet',
      'erledigt',
    ];
    for (let i = 0; i < validStates.length; i++) {
      await db.insert(projects).values({
        number: `CHK-VS-${i}`,
        title: `valid status: ${validStates[i]}`,
        customerId: testCustomerId,
        status: validStates[i]!,
      });
    }
  });

  it('AT-46: rejects INSERT where plannedEnd < plannedStart', async () => {
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO projects (number, title, customer_id, planned_start, planned_end)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'CHK-DATE-01',
          'end before start',
          testCustomerId,
          '2026-06-15T00:00:00Z',
          '2026-06-01T00:00:00Z',
        ],
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }

    expect(pgError).not.toBeNull();
    expect(pgError!.code).toBe('23514'); // check_violation
    expect(pgError!.constraint).toBe('projects_end_not_before_start');
  });

  it('AT-46: accepts equal start and end dates', async () => {
    await db.insert(projects).values({
      number: 'CHK-DATE-EQ',
      title: 'same day project',
      customerId: testCustomerId,
      plannedStart: new Date('2026-06-15T00:00:00Z'),
      plannedEnd: new Date('2026-06-15T00:00:00Z'),
    });
  });
});

// ---------------------------------------------------------------
// §15.18 AC-98: Customer audit FK SET NULL on user delete
// AT-47
// ---------------------------------------------------------------
describe('AC-98: Customer audit FK cascade', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AT-47: deleting a user nullifies createdBy/updatedBy on customers', async () => {
    // Create a temporary user
    const createUserRes = await authPost(token, '/api/users', {
      username: 'audit_fk_test_user',
      displayName: 'FK Test User',
      password: 'TestPass123!',
      roles: ['office'],
    });
    expect(createUserRes.statusCode).toBe(201);
    const tempUserId = createUserRes.json().id;

    // Log in as that user and create a customer
    const tempToken = await login('audit_fk_test_user', 'TestPass123!');
    const createCustRes = await authPost(tempToken, '/api/customers', {
      name: 'FK Audit Test Kunde',
    });
    expect(createCustRes.statusCode).toBe(201);
    const customerId = createCustRes.json().id;

    // Verify createdBy is set
    const beforeRes = await authGet(token, `/api/customers/${customerId}`);
    expect(beforeRes.json().createdBy).toBe(tempUserId);

    // Delete the user (as owner) — returns 204 No Content
    const deleteRes = await authDelete(token, `/api/users/${tempUserId}`);
    expect(deleteRes.statusCode).toBe(204);

    // Verify createdBy is now null
    const afterRes = await authGet(token, `/api/customers/${customerId}`);
    expect(afterRes.json().createdBy).toBeNull();

    // Clean up the test customer
    await authDelete(token, `/api/customers/${customerId}`);
  });
});

// ---------------------------------------------------------------
// §15.18 AC-99: Atomic project creation
// AT-48
// ---------------------------------------------------------------
describe('AC-99: Atomic project creation', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AT-48: invalid worker ID rolls back entire project creation', async () => {
    const customerRes = await authGet(token, '/api/customers');
    const custId = customerRes.json().customers[0].id;
    const fakeWorkerId = '00000000-0000-0000-0000-000000000099';

    const res = await authPost(token, '/api/projects', {
      number: 'ATOMIC-FAIL-01',
      title: 'should not persist',
      customerId: custId,
      assignedWorkerIds: [fakeWorkerId],
    });

    // The request should fail (FK violation on workers)
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    // The project should NOT exist in the database
    const listRes = await authGet(token, '/api/projects');
    const orphan = listRes
      .json()
      .data.find((p: Record<string, unknown>) => p.number === 'ATOMIC-FAIL-01');
    expect(orphan).toBeUndefined();
  });
});
