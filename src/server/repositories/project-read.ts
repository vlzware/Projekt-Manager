/**
 * Project repository — read & create operations.
 */

import { eq, count, inArray } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { projects, projectWorkers, users } from '../db/schema.js';
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
 * Workers are attached separately via fetchWorkers*.
 */
export function toProject(
  row: ProjectRow,
  workers: { userId: string; displayName: string }[] = [],
) {
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
    assignedWorkers: workers.length > 0 ? workers : null,
    estimatedValue: row.estimatedValue ? Number(row.estimatedValue) : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

/** Fetch assigned workers for a single project. */
async function fetchWorkersForProject(
  db: Database,
  projectId: string,
): Promise<{ userId: string; displayName: string }[]> {
  return db
    .select({ userId: projectWorkers.userId, displayName: users.displayName })
    .from(projectWorkers)
    .innerJoin(users, eq(projectWorkers.userId, users.id))
    .where(eq(projectWorkers.projectId, projectId));
}

/** Fetch assigned workers for multiple projects, grouped by projectId. */
async function fetchWorkersForProjects(
  db: Database,
  projectIds: string[],
): Promise<Map<string, { userId: string; displayName: string }[]>> {
  const map = new Map<string, { userId: string; displayName: string }[]>();
  if (projectIds.length === 0) return map;

  const rows = await db
    .select({
      projectId: projectWorkers.projectId,
      userId: projectWorkers.userId,
      displayName: users.displayName,
    })
    .from(projectWorkers)
    .innerJoin(users, eq(projectWorkers.userId, users.id))
    .where(inArray(projectWorkers.projectId, projectIds));

  for (const row of rows) {
    const list = map.get(row.projectId);
    if (list) {
      list.push({ userId: row.userId, displayName: row.displayName });
    } else {
      map.set(row.projectId, [{ userId: row.userId, displayName: row.displayName }]);
    }
  }
  return map;
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

  const workerMap = await fetchWorkersForProjects(
    db,
    rows.map((r) => r.id),
  );
  const data = rows.map((r) => toProject(r, workerMap.get(r.id) ?? []));

  return { data, total };
}

export async function getProject(
  db: Database,
  id: string,
): Promise<ReturnType<typeof toProject> | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);

  if (rows.length === 0) return null;
  const workers = await fetchWorkersForProject(db, id);
  return toProject(rows[0]!, workers);
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
    assignedWorkerIds?: string[] | null;
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
      estimatedValue: data.estimatedValue ?? null,
      notes: data.notes ?? null,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy ?? null,
      updatedBy: data.updatedBy ?? null,
    })
    .returning();

  const project = rows[0]!;
  let workers: { userId: string; displayName: string }[] = [];

  if (data.assignedWorkerIds && data.assignedWorkerIds.length > 0) {
    await db.insert(projectWorkers).values(
      data.assignedWorkerIds.map((userId) => ({
        projectId: project.id,
        userId,
      })),
    );
    workers = await fetchWorkersForProject(db, project.id);
  }

  return toProject(project, workers);
}
