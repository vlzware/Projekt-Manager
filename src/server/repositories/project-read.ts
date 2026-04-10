/**
 * Project repository — read & create operations.
 */

import { eq, count } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { projects } from '../db/schema.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';

export type ProjectRow = typeof projects.$inferSelect;

/** Thrown when a project ID does not exist. */
export class ProjectNotFoundError extends Error {
  constructor() {
    super(STRINGS.errors.notFound(STRINGS.entities.project));
    this.name = 'ProjectNotFoundError';
  }
}

/**
 * Convert a database row to the API-facing Project shape.
 */
export function toProject(row: ProjectRow) {
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
  const baseQuery = db.select().from(projects);
  const paginatedQuery =
    opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery;

  const [rows, countResult] = await Promise.all([
    paginatedQuery,
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
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);

  if (rows.length === 0) return null;
  return toProject(rows[0]!);
}

/**
 * Insert a single project.
 * Returns the newly created project in the API-facing shape.
 */
export async function insertProject(
  db: Database,
  data: {
    number: string;
    title: string;
    status: WorkflowState;
    customer: { name: string; phone?: string; email?: string };
    address?: { street: string; zip: string; city: string } | null;
    plannedStart?: Date | null;
    plannedEnd?: Date | null;
    assignedWorkers?: string[] | null;
    estimatedValue?: string | null;
    notes?: string | null;
    createdBy?: string | null;
    updatedBy?: string | null;
  },
): Promise<ReturnType<typeof toProject>> {
  const now = new Date();
  const rows = await db
    .insert(projects)
    .values({
      number: data.number,
      title: data.title,
      status: data.status,
      statusChangedAt: now,
      customer: data.customer,
      address: data.address ?? null,
      plannedStart: data.plannedStart ?? null,
      plannedEnd: data.plannedEnd ?? null,
      assignedWorkers: data.assignedWorkers ?? null,
      estimatedValue: data.estimatedValue ?? null,
      notes: data.notes ?? null,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy ?? null,
      updatedBy: data.updatedBy ?? null,
    })
    .returning();

  return toProject(rows[0]!);
}
