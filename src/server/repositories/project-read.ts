/**
 * Project repository — read & create operations.
 */

import { eq, count, inArray, and, ilike, or, isNull } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { projects, projectWorkers, users, customers } from '../db/schema.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { formatDateOnly } from '../../domain/dateFormat.js';

/** Escape LIKE-pattern metacharacters so user input is treated literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

export type ProjectRow = typeof projects.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;

/** Thrown when a project ID does not exist. */
export class ProjectNotFoundError extends Error {
  constructor() {
    super(STRINGS.errors.notFound(STRINGS.entities.project));
    this.name = 'ProjectNotFoundError';
  }
}

/** Shape of the nested customer in the API response. */
function toCustomer(row: CustomerRow) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
  };
}

/**
 * Convert a database row + joined customer to the API-facing Project shape.
 * Workers are attached separately via fetchWorkers*.
 */
export function toProject(
  row: ProjectRow,
  customer: CustomerRow | null,
  workers: { userId: string; displayName: string }[] = [],
) {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
    customerId: row.customerId,
    customer: customer ? toCustomer(customer) : null,
    plannedStart: row.plannedStart ? formatDateOnly(row.plannedStart) : null,
    plannedEnd: row.plannedEnd ? formatDateOnly(row.plannedEnd) : null,
    assignedWorkers: workers.length > 0 ? workers : null,
    estimatedValue: row.estimatedValue ? Number(row.estimatedValue) : null,
    notes: row.notes ?? null,
    deleted: row.deleted,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
  };
}

/**
 * Fetch assigned workers for a single project.
 */
export async function fetchWorkersForProject(
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
export async function fetchWorkersForProjects(
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

/** Fetch customers for multiple projects, keyed by customer ID. */
async function fetchCustomersForProjects(
  db: Database,
  customerIds: string[],
): Promise<Map<string, CustomerRow>> {
  const map = new Map<string, CustomerRow>();
  if (customerIds.length === 0) return map;

  const unique = [...new Set(customerIds)];
  const rows = await db.select().from(customers).where(inArray(customers.id, unique));
  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

export interface ListProjectsOpts {
  offset?: number;
  limit?: number;
  status?: string | string[];
  search?: string;
  hasNoDates?: boolean;
  customerId?: string;
}

export async function listProjects(
  db: Database,
  opts: ListProjectsOpts = {},
): Promise<{ data: ReturnType<typeof toProject>[]; total: number }> {
  // Build WHERE conditions
  const conditions = [eq(projects.deleted, false)];

  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    if (statuses.length === 1) {
      conditions.push(eq(projects.status, statuses[0]!));
    } else if (statuses.length > 1) {
      conditions.push(inArray(projects.status, statuses));
    }
  }

  if (opts.hasNoDates) {
    conditions.push(isNull(projects.plannedStart));
    conditions.push(isNull(projects.plannedEnd));
  }

  if (opts.customerId) {
    conditions.push(eq(projects.customerId, opts.customerId));
  }

  const whereClause = and(...conditions);

  // For search, we need to join customers to search across customer name.
  // We always join to hydrate customer data anyway.
  if (opts.search) {
    const pattern = `%${escapeLike(opts.search)}%`;
    const searchCondition = or(
      ilike(projects.number, pattern),
      ilike(projects.title, pattern),
      ilike(customers.name, pattern),
    );

    const baseQuery = db
      .select({ project: projects, customer: customers })
      .from(projects)
      .innerJoin(customers, eq(projects.customerId, customers.id))
      .where(and(whereClause, searchCondition));

    const paginatedQuery =
      opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery;

    const countQuery = db
      .select({ value: count() })
      .from(projects)
      .innerJoin(customers, eq(projects.customerId, customers.id))
      .where(and(whereClause, searchCondition));

    const [rows, countResult] = await Promise.all([paginatedQuery, countQuery]);
    const total = countResult[0]?.value ?? 0;

    const workerMap = await fetchWorkersForProjects(
      db,
      rows.map((r) => r.project.id),
    );
    const data = rows.map((r) =>
      toProject(r.project, r.customer, workerMap.get(r.project.id) ?? []),
    );

    return { data, total };
  }

  // No search — simpler query path
  const baseQuery = db.select().from(projects).where(whereClause);
  const paginatedQuery =
    opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery;

  const [rows, countResult] = await Promise.all([
    paginatedQuery,
    db.select({ value: count() }).from(projects).where(whereClause),
  ]);

  const total = countResult[0]?.value ?? 0;

  const customerMap = await fetchCustomersForProjects(
    db,
    rows.map((r) => r.customerId),
  );
  const workerMap = await fetchWorkersForProjects(
    db,
    rows.map((r) => r.id),
  );
  const data = rows.map((r) =>
    toProject(r, customerMap.get(r.customerId) ?? null, workerMap.get(r.id) ?? []),
  );

  return { data, total };
}

export async function getProject(
  db: Database,
  id: string,
): Promise<ReturnType<typeof toProject> | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.deleted, false)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  const [workers, customerRows] = await Promise.all([
    fetchWorkersForProject(db, id),
    db.select().from(customers).where(eq(customers.id, row.customerId)).limit(1),
  ]);
  return toProject(row, customerRows[0] ?? null, workers);
}

/**
 * Insert a single project.
 * Returns the newly created project in the API-facing shape.
 */
export async function insertProject(
  db: Database,
  data: {
    id?: string;
    number: string;
    title: string;
    status: WorkflowState;
    customerId: string;
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
  const project = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(projects)
      .values({
        ...(data.id !== undefined ? { id: data.id } : {}),
        number: data.number,
        title: data.title,
        status: data.status,
        statusChangedAt: now,
        customerId: data.customerId,
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

    const row = rows[0]!;

    if (data.assignedWorkerIds && data.assignedWorkerIds.length > 0) {
      await tx.insert(projectWorkers).values(
        data.assignedWorkerIds.map((userId) => ({
          projectId: row.id,
          userId,
        })),
      );
    }

    return row;
  });

  // Hydrate workers + customer outside the transaction
  const [workers, customerRows] = await Promise.all([
    data.assignedWorkerIds?.length
      ? fetchWorkersForProject(db, project.id)
      : Promise.resolve([] as { userId: string; displayName: string }[]),
    db.select().from(customers).where(eq(customers.id, project.customerId)).limit(1),
  ]);

  return toProject(project, customerRows[0] ?? null, workers);
}

/**
 * Update project fields (PATCH semantics).
 * Does NOT update status or number — those use dedicated operations.
 */
export async function updateProject(
  db: Database,
  id: string,
  userId: string,
  data: {
    title?: string;
    customerId?: string;
    assignedWorkerIds?: string[];
    estimatedValue?: number | null;
    notes?: string | null;
  },
): Promise<ReturnType<typeof toProject>> {
  const row = await db.transaction(async (tx) => {
    const now = new Date();

    // Build the SET clause dynamically — only include fields that were provided
    const setClause: Record<string, unknown> = {
      updatedAt: now,
      updatedBy: userId,
    };
    if (data.title !== undefined) setClause.title = data.title;
    if (data.customerId !== undefined) setClause.customerId = data.customerId;
    if (data.estimatedValue !== undefined) {
      setClause.estimatedValue = data.estimatedValue !== null ? String(data.estimatedValue) : null;
    }
    if (data.notes !== undefined) setClause.notes = data.notes;

    const rows = await tx
      .update(projects)
      .set(setClause)
      .where(and(eq(projects.id, id), eq(projects.deleted, false)))
      .returning();

    if (rows.length === 0) throw new ProjectNotFoundError();
    const project = rows[0]!;

    // Handle worker reassignment if provided
    if (data.assignedWorkerIds !== undefined) {
      await tx.delete(projectWorkers).where(eq(projectWorkers.projectId, id));
      if (data.assignedWorkerIds.length > 0) {
        await tx.insert(projectWorkers).values(
          data.assignedWorkerIds.map((wId) => ({
            projectId: id,
            userId: wId,
          })),
        );
      }
    }

    return project;
  });

  // Hydrate workers + customer outside the transaction (same pattern as transitions)
  const [workers, customerRows] = await Promise.all([
    fetchWorkersForProject(db, id),
    db.select().from(customers).where(eq(customers.id, row.customerId)).limit(1),
  ]);

  return toProject(row, customerRows[0] ?? null, workers);
}

/**
 * Fetch the raw DB row by id (including soft-deleted). Used by the
 * idempotency path in ProjectService.createProject — it compares the stored
 * project against the request body. We intentionally ignore the `deleted`
 * flag here: a client replaying a create must not get a soft-deleted row
 * back, but the caller needs to disambiguate "id taken" from "id free".
 */
export async function getProjectRowById(db: Database, id: string): Promise<ProjectRow | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Soft-delete a project (set deleted = true).
 */
export async function softDeleteProject(db: Database, id: string, userId: string): Promise<void> {
  const rows = await db
    .update(projects)
    .set({ deleted: true, updatedAt: new Date(), updatedBy: userId })
    .where(and(eq(projects.id, id), eq(projects.deleted, false)))
    .returning({ id: projects.id });

  if (rows.length === 0) throw new ProjectNotFoundError();
}
