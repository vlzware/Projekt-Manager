/**
 * Project repository — state transition operations.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { projects } from '../db/schema.js';
import { WORKFLOW_ORDER } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { toProject, fetchWorkersForProject, ProjectNotFoundError } from './project-read.js';

/**
 * Result of a transition: both the previous status and the updated project,
 * captured atomically inside the same transaction. The `before` field is what
 * audit subscribers (event seam) need to construct a from→to event without a
 * second read against a state that may already have moved.
 */
export interface TransitionResult {
  /** The status the project held immediately before the update committed. */
  before: WorkflowState;
  /** The updated project after the transition. */
  project: ReturnType<typeof toProject>;
}

/**
 * Transition a project forward by one state.
 * Rejects terminal state (erledigt).
 */
export async function transitionForward(
  db: Database,
  id: string,
  userId: string,
): Promise<TransitionResult> {
  const txResult = await db.transaction(async (tx) => {
    const rows = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);

    if (rows.length === 0) {
      throw new ProjectNotFoundError();
    }

    const project = rows[0]!;
    const before = project.status as WorkflowState;
    const currentIndex = WORKFLOW_ORDER.indexOf(before);

    if (currentIndex === -1 || currentIndex === WORKFLOW_ORDER.length - 1) {
      throw new TransitionError(STRINGS.projects.cannotAdvanceTerminal);
    }

    const nextStatus = WORKFLOW_ORDER[currentIndex + 1]!;
    const now = new Date();

    const updated = await tx
      .update(projects)
      .set({
        status: nextStatus,
        statusChangedAt: now,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(projects.id, id))
      .returning();

    return { before, row: updated[0]! };
  });

  // Hydrate assignedWorkers into the API response. Transitions do not
  // touch project_workers, so reading outside the transaction is safe
  // and lets us keep a narrower tx scope. See consolidation review B F-1.
  const workers = await fetchWorkersForProject(db, id);
  return { before: txResult.before, project: toProject(txResult.row, workers) };
}

/**
 * Transition a project backward by one state.
 * Rejects first state (anfrage) and terminal state (erledigt).
 */
export async function transitionBackward(
  db: Database,
  id: string,
  userId: string,
): Promise<TransitionResult> {
  const txResult = await db.transaction(async (tx) => {
    const rows = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);

    if (rows.length === 0) {
      throw new ProjectNotFoundError();
    }

    const project = rows[0]!;
    const before = project.status as WorkflowState;
    const currentIndex = WORKFLOW_ORDER.indexOf(before);

    if (currentIndex === -1 || currentIndex === 0) {
      throw new TransitionError(STRINGS.projects.cannotRevertFirst);
    }

    // Terminal state also rejects backward
    if (currentIndex === WORKFLOW_ORDER.length - 1) {
      throw new TransitionError(STRINGS.projects.cannotRevertTerminal);
    }

    const prevStatus = WORKFLOW_ORDER[currentIndex - 1]!;
    const now = new Date();

    const updated = await tx
      .update(projects)
      .set({
        status: prevStatus,
        statusChangedAt: now,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(projects.id, id))
      .returning();

    return { before, row: updated[0]! };
  });

  // Hydrate assignedWorkers into the API response — see note in
  // transitionForward above. Consolidation review B F-1.
  const workers = await fetchWorkersForProject(db, id);
  return { before: txResult.before, project: toProject(txResult.row, workers) };
}

/** Thrown when a state transition is invalid. */
export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}
