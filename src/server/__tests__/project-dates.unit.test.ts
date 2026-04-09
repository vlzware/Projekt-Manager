/**
 * Unit tests: Project date update business logic.
 *
 * Tests updateDates directly against the database — no HTTP layer,
 * no auth middleware. Validates date constraint enforcement:
 * start-only, start+end, end-without-start, end-before-start, and clearing.
 *
 * Database setup mirrors the existing integration test pattern
 * (createDatabase, migrate, seed with force).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seed } from '../seed.js';
import { projects, users } from '../db/schema.js';
import { updateDates, DateValidationError } from '../repositories/project-dates.js';
import { ProjectNotFoundError } from '../repositories/project-read.js';
import type { Database } from '../db/connection.js';
import type pg from 'pg';
import { setupTestDb, teardownTestDb } from './helpers/setup-db.js';

let db: Database;
let pool: pg.Pool;

/** A real seeded user ID, resolved in beforeEach so the FK on
 *  projects.updated_by → users.id is satisfied. */
let TEST_USER_ID!: string;

/** Find the first project that has no planned dates. */
async function findProjectWithoutDates() {
  const rows = await db.select().from(projects);
  return rows.find((r) => r.plannedStart == null && r.plannedEnd == null) ?? null;
}

/** Find the first project that has both planned dates set. */
async function findProjectWithDates() {
  const rows = await db.select().from(projects);
  return rows.find((r) => r.plannedStart != null && r.plannedEnd != null) ?? null;
}

describe('updateDates', () => {
  beforeAll(async () => {
    const conn = await setupTestDb();
    db = conn.db;
    pool = conn.pool;
  });

  beforeEach(async () => {
    // Re-seed before each test for a clean slate.
    await seed(db, { force: true });
    // Resolve a real seeded user id (FK on projects.updated_by → users.id).
    const [user] = await db.select({ id: users.id }).from(users).limit(1);
    TEST_USER_ID = user!.id;
  });

  afterAll(async () => {
    await teardownTestDb(pool);
  });

  // -----------------------------------------------------------------
  // Valid cases
  // -----------------------------------------------------------------

  it('sets start date only (no end) — valid single-day block', async () => {
    const project = await findProjectWithoutDates();
    expect(project).not.toBeNull();

    const result = await updateDates(db, project!.id, TEST_USER_ID, {
      plannedStart: '2026-06-01',
    });

    expect(result.plannedStart).toMatch('2026-06-01');
    expect(result.plannedEnd).toBeNull();
    expect(result.updatedBy).toBe(TEST_USER_ID);
  });

  it('sets start and end (end >= start) — valid range', async () => {
    const project = await findProjectWithoutDates();
    expect(project).not.toBeNull();

    const result = await updateDates(db, project!.id, TEST_USER_ID, {
      plannedStart: '2026-06-01',
      plannedEnd: '2026-06-10',
    });

    expect(result.plannedStart).toMatch('2026-06-01');
    expect(result.plannedEnd).toMatch('2026-06-10');
  });

  it('accepts start and end on the same day (end === start)', async () => {
    const project = await findProjectWithoutDates();
    expect(project).not.toBeNull();

    const result = await updateDates(db, project!.id, TEST_USER_ID, {
      plannedStart: '2026-06-01',
      plannedEnd: '2026-06-01',
    });

    expect(result.plannedStart).toMatch('2026-06-01');
    expect(result.plannedEnd).toMatch('2026-06-01');
  });

  it('clears start date (null) when no end exists — valid', async () => {
    const project = await findProjectWithoutDates();
    expect(project).not.toBeNull();

    // First set a start date
    await updateDates(db, project!.id, TEST_USER_ID, {
      plannedStart: '2026-06-01',
    });

    // Now clear it
    const result = await updateDates(db, project!.id, TEST_USER_ID, {
      plannedStart: '',
    });

    expect(result.plannedStart).toBeNull();
    expect(result.plannedEnd).toBeNull();
  });

  it('clears both dates — valid', async () => {
    const project = await findProjectWithDates();
    expect(project).not.toBeNull();

    const result = await updateDates(db, project!.id, TEST_USER_ID, {
      plannedStart: '',
      plannedEnd: '',
    });

    expect(result.plannedStart).toBeNull();
    expect(result.plannedEnd).toBeNull();
  });

  it('does NOT update statusChangedAt when dates change', async () => {
    const project = await findProjectWithoutDates();
    expect(project).not.toBeNull();

    const originalStatusChangedAt = project!.statusChangedAt;

    const result = await updateDates(db, project!.id, TEST_USER_ID, {
      plannedStart: '2026-07-01',
      plannedEnd: '2026-07-15',
    });

    // statusChangedAt must remain unchanged — date edits are not transitions
    expect(result.statusChangedAt).toBe(originalStatusChangedAt.toISOString());
  });

  it('updates updatedAt when dates change', async () => {
    const project = await findProjectWithoutDates();
    expect(project).not.toBeNull();

    const originalUpdatedAt = project!.updatedAt;

    const result = await updateDates(db, project!.id, TEST_USER_ID, {
      plannedStart: '2026-07-01',
    });

    expect(new Date(result.updatedAt).getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  // -----------------------------------------------------------------
  // Invalid cases
  // -----------------------------------------------------------------

  it('throws DateValidationError when setting end without start', async () => {
    const project = await findProjectWithoutDates();
    expect(project).not.toBeNull();

    await expect(
      updateDates(db, project!.id, TEST_USER_ID, {
        plannedEnd: '2026-06-10',
      }),
    ).rejects.toThrow(DateValidationError);
  });

  it('throws DateValidationError when end is before start', async () => {
    const project = await findProjectWithoutDates();
    expect(project).not.toBeNull();

    await expect(
      updateDates(db, project!.id, TEST_USER_ID, {
        plannedStart: '2026-06-15',
        plannedEnd: '2026-06-01',
      }),
    ).rejects.toThrow(DateValidationError);
  });

  it('throws ProjectNotFoundError for a nonexistent project ID', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';

    await expect(
      updateDates(db, fakeId, TEST_USER_ID, {
        plannedStart: '2026-06-01',
      }),
    ).rejects.toThrow(ProjectNotFoundError);
  });

  // -----------------------------------------------------------------
  // #54: DB-level enforcement of the same invariant
  // -----------------------------------------------------------------

  it('DB CHECK constraint rejects direct INSERT of plannedEnd without plannedStart', async () => {
    // The API layer already rejects this via updateDates (tested above), but
    // direct DB writes (seed scripts, migrations, manual SQL) bypass the route
    // layer. The `projects_end_requires_start` CHECK constraint is defense in
    // depth — this test verifies the constraint is actually enforced, not just
    // present in the schema file. Use the raw pg pool so the constraint name
    // surfaces in the error (drizzle's wrapper hides it).
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO projects (number, title, customer, planned_start, planned_end)
         VALUES ($1, $2, $3, NULL, $4)`,
        ['CHK-01', 'end without start', { name: 'Test' }, '2026-06-10T00:00:00Z'],
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }

    expect(pgError).not.toBeNull();
    // PG error code 23514 = check_violation
    expect(pgError!.code).toBe('23514');
    expect(pgError!.constraint).toBe('projects_end_requires_start');
  });

  it('DB CHECK constraint allows start without end, both dates, and neither', async () => {
    // All three valid combinations must insert cleanly. If the constraint is
    // written incorrectly (e.g., rejects start-only), this test surfaces it.
    const base = {
      title: 'constraint positive case',
      customer: { name: 'Test' },
    } as const;

    // Neither date
    await db
      .insert(projects)
      .values({ ...base, number: 'CHK-N', plannedStart: null, plannedEnd: null });

    // Start only
    await db.insert(projects).values({
      ...base,
      number: 'CHK-S',
      plannedStart: new Date('2026-06-01T00:00:00Z'),
      plannedEnd: null,
    });

    // Both dates
    await db.insert(projects).values({
      ...base,
      number: 'CHK-B',
      plannedStart: new Date('2026-06-01T00:00:00Z'),
      plannedEnd: new Date('2026-06-10T00:00:00Z'),
    });
  });
});
