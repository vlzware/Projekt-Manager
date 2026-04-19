/**
 * Project repository — state transition operations.
 */

import { eq, and } from 'drizzle-orm';
import type { MutatingDatabase } from '../db/connection.js';
import { projects, customers } from '../db/schema.js';
import { WORKFLOW_ORDER } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { toProject, fetchWorkersForProject, ProjectNotFoundError } from './project-read.js';

/**
 * Result of a transition: both the previous status and the updated project.
 * `before` equals the client's `expectedStatus` — the guard that `before` did
 * not drift from the client's view is enforced by the conditional UPDATE, so
 * returning the asserted value is accurate for audit/event subscribers.
 */
export interface TransitionResult {
  before: WorkflowState;
  project: ReturnType<typeof toProject>;
}

/**
 * Transition a project forward by one state.
 *
 * The caller supplies `expectedStatus` — the status the client observed in its
 * last read. A single conditional UPDATE advances the row only when the stored
 * status still matches that value; a sequential double-advance (two clicks in
 * sequence, two tabs, etc.) deterministically resolves to CONFLICT on the
 * second attempt because its `expectedStatus` no longer matches the DB.
 */
export async function transitionForward(
  db: MutatingDatabase,
  id: string,
  userId: string,
  expectedStatus: WorkflowState,
): Promise<TransitionResult> {
  const currentIndex = WORKFLOW_ORDER.indexOf(expectedStatus);
  if (currentIndex === -1 || currentIndex === WORKFLOW_ORDER.length - 1) {
    throw new TransitionError(STRINGS.projects.cannotAdvanceTerminal);
  }
  const nextStatus = WORKFLOW_ORDER[currentIndex + 1]!;
  return applyTransition(db, id, userId, expectedStatus, nextStatus);
}

/**
 * Transition a project backward by one state.
 *
 * Same `expectedStatus` contract as `transitionForward`.
 */
export async function transitionBackward(
  db: MutatingDatabase,
  id: string,
  userId: string,
  expectedStatus: WorkflowState,
): Promise<TransitionResult> {
  const currentIndex = WORKFLOW_ORDER.indexOf(expectedStatus);
  if (currentIndex === -1) {
    throw new TransitionError(STRINGS.projects.cannotRevertFirst);
  }
  if (currentIndex === 0) {
    throw new TransitionError(STRINGS.projects.cannotRevertFirst);
  }
  if (currentIndex === WORKFLOW_ORDER.length - 1) {
    throw new TransitionError(STRINGS.projects.cannotRevertTerminal);
  }
  const prevStatus = WORKFLOW_ORDER[currentIndex - 1]!;
  return applyTransition(db, id, userId, expectedStatus, prevStatus);
}

async function applyTransition(
  db: MutatingDatabase,
  id: string,
  userId: string,
  expectedStatus: WorkflowState,
  nextStatus: WorkflowState,
): Promise<TransitionResult> {
  const now = new Date();

  const updated = await db
    .update(projects)
    .set({
      status: nextStatus,
      statusChangedAt: now,
      updatedAt: now,
      updatedBy: userId,
    })
    .where(
      and(eq(projects.id, id), eq(projects.deleted, false), eq(projects.status, expectedStatus)),
    )
    .returning();

  if (updated.length === 0) {
    // Disambiguate: is the row missing/soft-deleted (404) or just stale (409)?
    const probe = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.deleted, false)))
      .limit(1);
    if (probe.length === 0) {
      throw new ProjectNotFoundError();
    }
    throw new ConcurrentModificationError();
  }

  const row = updated[0]!;
  const [workers, customerRows] = await Promise.all([
    fetchWorkersForProject(db, id),
    db.select().from(customers).where(eq(customers.id, row.customerId)).limit(1),
  ]);
  return {
    before: expectedStatus,
    project: toProject(row, customerRows[0] ?? null, workers),
  };
}

/** Thrown when a state transition is invalid. */
export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

/** Thrown when a concurrent modification prevented the transition. */
export class ConcurrentModificationError extends Error {
  constructor() {
    super(STRINGS.projects.concurrentModification);
    this.name = 'ConcurrentModificationError';
  }
}
