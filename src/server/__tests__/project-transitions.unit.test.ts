/**
 * Unit tests: Project state transition business logic.
 *
 * Tests transitionForward and transitionBackward directly against the
 * database — no HTTP layer, no auth middleware. Validates the 9-state
 * workflow transitions, including rejection of terminal/boundary states.
 *
 * Database setup mirrors the existing integration test pattern
 * (createDatabase, migrate, seed with force).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seed } from '../seed.js';
import { eq } from 'drizzle-orm';
import { projects, users } from '../db/schema.js';
import {
  transitionForward,
  transitionBackward,
  TransitionError,
} from '../repositories/project-transitions.js';
import { ProjectNotFoundError } from '../repositories/project-read.js';
import { WORKFLOW_ORDER } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import type { Database } from '../db/connection.js';
import type pg from 'pg';
import { setupTestDb, teardownTestDb } from './helpers/setup-db.js';

let db: Database;
let pool: pg.Pool;

/** A real seeded user ID, resolved in beforeEach so the FK on
 *  projects.updated_by → users.id is satisfied. The definite-assignment
 *  assertion is safe because beforeEach runs before every test. */
let TEST_USER_ID!: string;

/** Find the first project in a given state. */
async function findProjectByStatus(status: WorkflowState) {
  const rows = await db.select().from(projects).where(eq(projects.status, status)).limit(1);
  return rows[0] ?? null;
}

// Single connection for the entire file.
beforeAll(async () => {
  const conn = await setupTestDb();
  db = conn.db;
  pool = conn.pool;
});

beforeEach(async () => {
  // Re-seed before each test for a clean slate — transitions mutate state.
  await seed(db, { force: true });
  // Resolve a real seeded user id (the FK on projects.updated_by → users.id
  // requires a valid user, so we cannot reuse a hardcoded constant).
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  TEST_USER_ID = user!.id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('transitionForward', () => {
  it('moves a project from anfrage to angebot', async () => {
    const project = await findProjectByStatus('anfrage');
    expect(project).not.toBeNull();

    const result = await transitionForward(db, project!.id, TEST_USER_ID);

    expect(result.before).toBe('anfrage');
    expect(result.project.status).toBe('angebot');
    expect(result.project.updatedBy).toBe(TEST_USER_ID);
  });

  // Test forward transition from each intermediate state (not erledigt).
  const intermediateStates = WORKFLOW_ORDER.slice(0, -1); // all except erledigt

  for (let i = 0; i < intermediateStates.length; i++) {
    const from = intermediateStates[i]!;
    const to = WORKFLOW_ORDER[i + 1]!;

    it(`moves a project from ${from} to ${to}`, async () => {
      const project = await findProjectByStatus(from);
      expect(project).not.toBeNull();

      const result = await transitionForward(db, project!.id, TEST_USER_ID);

      expect(result.before).toBe(from);
      expect(result.project.status).toBe(to);
    });
  }

  it('updates statusChangedAt and updatedAt on forward transition', async () => {
    const project = await findProjectByStatus('anfrage');
    expect(project).not.toBeNull();

    const originalStatusChangedAt = project!.statusChangedAt;
    const originalUpdatedAt = project!.updatedAt;

    const result = await transitionForward(db, project!.id, TEST_USER_ID);

    expect(new Date(result.project.statusChangedAt).getTime()).toBeGreaterThanOrEqual(
      originalStatusChangedAt.getTime(),
    );
    expect(new Date(result.project.updatedAt).getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('throws TransitionError when forwarding from erledigt (terminal state)', async () => {
    const project = await findProjectByStatus('erledigt');
    expect(project).not.toBeNull();

    await expect(transitionForward(db, project!.id, TEST_USER_ID)).rejects.toThrow(TransitionError);
  });

  it('throws ProjectNotFoundError for a nonexistent project ID', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';

    await expect(transitionForward(db, fakeId, TEST_USER_ID)).rejects.toThrow(ProjectNotFoundError);
  });
});

describe('transitionBackward', () => {
  it('moves a project from angebot back to anfrage', async () => {
    const project = await findProjectByStatus('angebot');
    expect(project).not.toBeNull();

    const result = await transitionBackward(db, project!.id, TEST_USER_ID);

    expect(result.before).toBe('angebot');
    expect(result.project.status).toBe('anfrage');
    expect(result.project.updatedBy).toBe(TEST_USER_ID);
  });

  it('throws TransitionError when going backward from anfrage (first state)', async () => {
    const project = await findProjectByStatus('anfrage');
    expect(project).not.toBeNull();

    await expect(transitionBackward(db, project!.id, TEST_USER_ID)).rejects.toThrow(
      TransitionError,
    );
  });

  it('throws TransitionError when going backward from erledigt (terminal state)', async () => {
    const project = await findProjectByStatus('erledigt');
    expect(project).not.toBeNull();

    await expect(transitionBackward(db, project!.id, TEST_USER_ID)).rejects.toThrow(
      TransitionError,
    );
  });

  it('updates statusChangedAt and updatedAt on backward transition', async () => {
    const project = await findProjectByStatus('angebot');
    expect(project).not.toBeNull();

    const originalStatusChangedAt = project!.statusChangedAt;
    const originalUpdatedAt = project!.updatedAt;

    const result = await transitionBackward(db, project!.id, TEST_USER_ID);

    expect(new Date(result.project.statusChangedAt).getTime()).toBeGreaterThanOrEqual(
      originalStatusChangedAt.getTime(),
    );
    expect(new Date(result.project.updatedAt).getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('throws ProjectNotFoundError for a nonexistent project ID', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';

    await expect(transitionBackward(db, fakeId, TEST_USER_ID)).rejects.toThrow(
      ProjectNotFoundError,
    );
  });
});
