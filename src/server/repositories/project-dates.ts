/**
 * Project repository — date update operations.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { projects } from '../db/schema.js';
import { toProject, ProjectNotFoundError } from './project-read.js';

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
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);

    if (rows.length === 0) {
      throw new ProjectNotFoundError();
    }

    const project = rows[0]!;

    // Effective dates after the update.
    // Precedence: new value > existing value > null.
    // When only plannedStart is sent (no plannedEnd key), plannedEnd is cleared.
    const effectiveStart =
      dates.plannedStart !== undefined
        ? dates.plannedStart
          ? new Date(dates.plannedStart)
          : null
        : (project.plannedStart ?? null);
    const effectiveEnd =
      'plannedEnd' in dates
        ? dates.plannedEnd
          ? new Date(dates.plannedEnd)
          : null
        : dates.plannedStart !== undefined
          ? null
          : (project.plannedEnd ?? null);

    if (effectiveEnd && !effectiveStart) {
      throw new DateValidationError('Enddatum kann nicht ohne Startdatum gesetzt werden.');
    }

    if (effectiveEnd && effectiveStart && effectiveEnd < effectiveStart) {
      throw new DateValidationError('Das Enddatum darf nicht vor dem Startdatum liegen.');
    }

    const now = new Date();

    const updateData: Record<string, unknown> = {
      updatedAt: now,
      updatedBy: userId,
    };

    if (dates.plannedStart !== undefined) {
      updateData.plannedStart = effectiveStart;
    }

    if ('plannedEnd' in dates) {
      updateData.plannedEnd = effectiveEnd;
    } else if (dates.plannedStart !== undefined) {
      // Only plannedStart sent without plannedEnd key — clear plannedEnd
      updateData.plannedEnd = null;
    }

    const updated = await tx
      .update(projects)
      .set(updateData)
      .where(eq(projects.id, id))
      .returning();

    return toProject(updated[0]!);
  });
}

/** Thrown when date validation fails. */
export class DateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateValidationError';
  }
}
