/**
 * Project repository — database operations for the projects table.
 */

import { eq, count } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { projects } from '../db/schema.js';
import { WORKFLOW_ORDER } from '@/config/stateConfig.js';
import type { WorkflowState } from '@/config/stateConfig.js';

export type ProjectRow = typeof projects.$inferSelect;

/**
 * Convert a database row to the API-facing Project shape.
 */
function toProject(row: ProjectRow) {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
    customer: row.customer,
    address: row.address ?? null,
    plannedStart: row.plannedStart?.toISOString() ?? null,
    plannedEnd: row.plannedEnd?.toISOString() ?? null,
    assignedWorkers: row.assignedWorkers,
    estimatedValue: row.estimatedValue ? Number(row.estimatedValue) : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

export async function listProjects(
  db: Database,
  opts: { offset?: number; limit?: number } = {},
): Promise<{ data: ReturnType<typeof toProject>[]; total: number }> {
  const [rows, countResult] = await Promise.all([
    db.select().from(projects),
    db.select({ value: count() }).from(projects),
  ]);

  const total = countResult[0]?.value ?? 0;
  const data = rows.map(toProject);

  return { data, total };
}

export async function getProject(
  db: Database,
  id: string,
): Promise<ReturnType<typeof toProject> | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (rows.length === 0) return null;
  return toProject(rows[0]!);
}

/**
 * Transition a project forward by one state.
 * Rejects terminal state (erledigt).
 */
export async function transitionForward(
  db: Database,
  id: string,
  userId: string,
): Promise<ReturnType<typeof toProject>> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new TransitionError('Projekt nicht gefunden.');
  }

  const project = rows[0]!;
  const currentIndex = WORKFLOW_ORDER.indexOf(project.status as WorkflowState);

  if (currentIndex === -1 || currentIndex === WORKFLOW_ORDER.length - 1) {
    throw new TransitionError(
      'Projekt kann nicht weiter vorgerückt werden. Der aktuelle Status ist ein Endstatus.',
    );
  }

  const nextStatus = WORKFLOW_ORDER[currentIndex + 1]!;
  const now = new Date();

  const updated = await db
    .update(projects)
    .set({
      status: nextStatus,
      statusChangedAt: now,
      updatedAt: now,
      updatedBy: userId,
    })
    .where(eq(projects.id, id))
    .returning();

  return toProject(updated[0]!);
}

/**
 * Transition a project backward by one state.
 * Rejects first state (anfrage) and terminal state (erledigt).
 */
export async function transitionBackward(
  db: Database,
  id: string,
  userId: string,
): Promise<ReturnType<typeof toProject>> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new TransitionError('Projekt nicht gefunden.');
  }

  const project = rows[0]!;
  const currentIndex = WORKFLOW_ORDER.indexOf(project.status as WorkflowState);

  if (currentIndex === -1 || currentIndex === 0) {
    throw new TransitionError(
      'Projekt kann nicht zurückgestuft werden. Der aktuelle Status ist bereits der erste Status.',
    );
  }

  // Terminal state also rejects backward
  if (currentIndex === WORKFLOW_ORDER.length - 1) {
    throw new TransitionError(
      'Projekt kann nicht zurückgestuft werden. Der aktuelle Status ist ein Endstatus.',
    );
  }

  const prevStatus = WORKFLOW_ORDER[currentIndex - 1]!;
  const now = new Date();

  const updated = await db
    .update(projects)
    .set({
      status: prevStatus,
      statusChangedAt: now,
      updatedAt: now,
      updatedBy: userId,
    })
    .where(eq(projects.id, id))
    .returning();

  return toProject(updated[0]!);
}

/**
 * Update planned dates on a project.
 * Must NOT update statusChangedAt.
 * Validates: end >= start, no end-only without start.
 */
export async function updateDates(
  db: Database,
  id: string,
  userId: string,
  dates: { plannedStart?: string; plannedEnd?: string },
): Promise<ReturnType<typeof toProject>> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new TransitionError('Projekt nicht gefunden.');
  }

  const project = rows[0]!;

  // Determine effective start/end considering both new values and existing values
  const newStart = dates.plannedStart !== undefined ? dates.plannedStart : (project.plannedStart?.toISOString() ?? null);
  const newEnd = dates.plannedEnd !== undefined ? dates.plannedEnd : undefined;

  // If plannedEnd is provided but plannedStart is not (neither new nor existing)
  if (newEnd && !newStart && !dates.plannedStart) {
    throw new DateValidationError(
      'Enddatum kann nicht ohne Startdatum gesetzt werden.',
    );
  }

  // If both are provided, end must be >= start
  if (dates.plannedStart && dates.plannedEnd) {
    const start = new Date(dates.plannedStart);
    const end = new Date(dates.plannedEnd);
    if (end < start) {
      throw new DateValidationError(
        'Das Enddatum darf nicht vor dem Startdatum liegen.',
      );
    }
  }

  const now = new Date();

  const updateData: Record<string, unknown> = {
    updatedAt: now,
    updatedBy: userId,
  };

  if (dates.plannedStart !== undefined) {
    updateData.plannedStart = dates.plannedStart ? new Date(dates.plannedStart) : null;
  }

  // If plannedEnd is explicitly provided (even as undefined key), set it
  if ('plannedEnd' in dates) {
    updateData.plannedEnd = dates.plannedEnd ? new Date(dates.plannedEnd) : null;
  } else {
    // If only plannedStart is provided without plannedEnd, clear plannedEnd
    if (dates.plannedStart !== undefined) {
      updateData.plannedEnd = null;
    }
  }

  const updated = await db
    .update(projects)
    .set(updateData)
    .where(eq(projects.id, id))
    .returning();

  return toProject(updated[0]!);
}

/** Thrown when a state transition is invalid. */
export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

/** Thrown when date validation fails. */
export class DateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateValidationError';
  }
}
