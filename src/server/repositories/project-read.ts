/**
 * Project repository — read & create operations.
 */

import { eq, count, inArray, and, ilike, or, isNull, desc } from 'drizzle-orm';
import type { Database, MutatingDatabase, TransactionalDatabase } from '../db/connection.js';
import { projects, projectWorkers, users, customers } from '../db/schema.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { formatDateOnly } from '../../domain/dateFormat.js';
import type { AuthUser } from '../middleware/auth.js';
import {
  projectScopeForCaller,
  isProjectInScope,
  OUT_OF_SCOPE,
  type ScopedReadResult,
} from './scope.js';

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

/**
 * Thrown when a purge (hard-delete) targets a project that is not yet
 * archived. The service maps this to 409 CONFLICT with a German message
 * directing the caller to archive first (AC-156).
 */
export class ProjectNotArchivedError extends Error {
  constructor() {
    super(STRINGS.projects.purgeRequiresArchive);
    this.name = 'ProjectNotArchivedError';
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
 * Fetch assigned workers for a single project. Accepts a transactional
 * handle so callers inside a tx can read the current assignment set as
 * part of the same snapshot as the mutation.
 */
export async function fetchWorkersForProject(
  db: TransactionalDatabase,
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
  /**
   * When true, include soft-deleted (archived) rows in the result.
   * Default `false` — archived rows excluded (AC-151). The flag composes
   * with all other filters via AND.
   */
  includeArchived?: boolean;
}

export async function listProjects(
  db: Database,
  caller: AuthUser,
  opts: ListProjectsOpts = {},
): Promise<{ data: ReturnType<typeof toProject>[]; total: number }> {
  // Build WHERE conditions. AC-151: only exclude archived rows when
  // includeArchived is not truthy — when true, the deleted predicate is
  // omitted so archived rows appear. All other filters still AND-compose.
  const conditions = [];
  if (!opts.includeArchived) {
    conditions.push(eq(projects.deleted, false));
  }

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

  // AC-145: apply per-caller read scope. Owner/office/bookkeeper → null
  // (no additional filter); worker → EXISTS-predicate over project_workers.
  const scope = projectScopeForCaller(caller);
  if (scope) conditions.push(scope);

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
      .where(and(whereClause, searchCondition))
      .orderBy(desc(projects.createdAt));

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
  const baseQuery = db.select().from(projects).where(whereClause).orderBy(desc(projects.createdAt));
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

/**
 * Get a project by id, respecting the caller's read scope.
 *
 * Three-valued result (ADR-0019):
 *   - `null`              — row does not exist (→ 404 NOT_FOUND)
 *   - `OUT_OF_SCOPE`      — row exists but caller is not assigned
 *                           (→ 403 NOT_PERMITTED; AC-147)
 *   - `ReturnType<toProject>` — in-scope row
 *
 * The two-step fetch (no-scope row lookup, then scope check) is deliberate:
 * a single scoped query cannot distinguish "not found" from "out of scope".
 * The separation honors the spec's explicit 403-over-404 contract.
 */
export async function getProject(
  db: Database,
  caller: AuthUser,
  id: string,
): Promise<ScopedReadResult<ReturnType<typeof toProject>>> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.deleted, false)))
    .limit(1);

  if (rows.length === 0) return null;

  if (!(await isProjectInScope(db, caller, id))) {
    return OUT_OF_SCOPE;
  }

  const row = rows[0]!;
  const [workers, customerRows] = await Promise.all([
    fetchWorkersForProject(db, id),
    db.select().from(customers).where(eq(customers.id, row.customerId)).limit(1),
  ]);
  return toProject(row, customerRows[0] ?? null, workers);
}

/**
 * Insert a single project row. Does NOT insert project_workers — the
 * service layer splits the worker-assignment writes into individual
 * `project_worker` audit events via `addProjectWorker` so each
 * assignment produces its own audit row (AC-177 grain).
 *
 * Runs against the provided transactional handle so the insert shares
 * the caller's transaction (ProjectCrudService.runCreateWithAudit).
 *
 * Returns the freshly-inserted raw row. The service is responsible for
 * hydrating the API-facing response shape (see `toProject`).
 */
export async function insertProject(
  db: MutatingDatabase,
  data: {
    id?: string;
    number: string;
    title: string;
    status: WorkflowState;
    customerId: string;
    plannedStart?: Date | null;
    plannedEnd?: Date | null;
    estimatedValue?: string | null;
    notes?: string | null;
    createdBy?: string | null;
    updatedBy?: string | null;
  },
): Promise<ProjectRow> {
  const now = new Date();
  const rows = await db
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

  return rows[0]!;
}

/**
 * Apply the project-level field update (title, customer, estimatedValue, notes).
 * Does NOT handle worker reassignment — that is split out into a separate
 * `replaceProjectWorkers` call so each add/remove can produce its own
 * audit row (AC-177 "every mutation produces exactly one audit_log row",
 * applied at the project_worker grain).
 *
 * Returns null when the project does not exist or is soft-deleted. The
 * caller must set at least one of the updatable fields; passing an empty
 * object is a programmer error.
 */
export async function updateProjectFields(
  db: MutatingDatabase,
  id: string,
  userId: string,
  data: {
    title?: string;
    customerId?: string;
    estimatedValue?: number | null;
    notes?: string | null;
  },
): Promise<ProjectRow | null> {
  const now = new Date();
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

  const rows = await db
    .update(projects)
    .set(setClause)
    .where(and(eq(projects.id, id), eq(projects.deleted, false)))
    .returning();

  return rows[0] ?? null;
}

/**
 * Compute the diff between the current project_workers set and the
 * requested assignedWorkerIds. Returns the ids to add and the ids to
 * remove as disjoint sets. Idempotent — an id present in both sets is
 * dropped from both.
 */
export async function diffProjectWorkers(
  db: TransactionalDatabase,
  projectId: string,
  requested: string[],
): Promise<{ toAdd: string[]; toRemove: string[]; existing: string[] }> {
  const current = await db
    .select({ userId: projectWorkers.userId })
    .from(projectWorkers)
    .where(eq(projectWorkers.projectId, projectId));
  const existing = current.map((r) => r.userId);
  const existingSet = new Set(existing);
  const requestedSet = new Set(requested);
  return {
    toAdd: requested.filter((id) => !existingSet.has(id)),
    toRemove: existing.filter((id) => !requestedSet.has(id)),
    existing,
  };
}

/** Add a single project_worker row. */
export async function addProjectWorker(
  db: MutatingDatabase,
  projectId: string,
  userId: string,
): Promise<void> {
  await db.insert(projectWorkers).values({ projectId, userId });
}

/** Remove a single project_worker row. */
export async function removeProjectWorker(
  db: MutatingDatabase,
  projectId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(projectWorkers)
    .where(and(eq(projectWorkers.projectId, projectId), eq(projectWorkers.userId, userId)));
}

/**
 * Fetch a worker's display name inside a transaction. Used by the
 * service layer to enrich `project_worker` audit payloads so the UI can
 * render "Mitarbeiter zugewiesen: Jan Nowak" (ui/workflow-views.md
 * §8.4.1) without a second round-trip at render time. Returns null for a
 * missing user — the caller falls back to the generic label.
 */
export async function getUserDisplayName(
  db: TransactionalDatabase,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.displayName ?? null;
}

/**
 * Fetch the raw DB row by id (including soft-deleted). Used by the
 * idempotency path in ProjectCrudService.createProject — it compares the stored
 * project against the request body. We intentionally ignore the `deleted`
 * flag here: a client replaying a create must not get a soft-deleted row
 * back, but the caller needs to disambiguate "id taken" from "id free".
 */
export async function getProjectRowById(
  db: TransactionalDatabase,
  id: string,
): Promise<ProjectRow | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Fetch the active (non-archived) project row by id. Services use this
 * inside a `mutate()` callback to capture `payload.before` within the
 * same snapshot as the write. Returns null for missing or soft-deleted
 * rows — callers map to 404.
 */
export async function getProjectForMutation(
  db: TransactionalDatabase,
  id: string,
): Promise<ProjectRow | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.deleted, false)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Soft-delete a project (set deleted = true).
 */
export async function softDeleteProject(
  db: MutatingDatabase,
  id: string,
  userId: string,
): Promise<void> {
  const rows = await db
    .update(projects)
    .set({ deleted: true, updatedAt: new Date(), updatedBy: userId })
    .where(and(eq(projects.id, id), eq(projects.deleted, false)))
    .returning({ id: projects.id });

  if (rows.length === 0) throw new ProjectNotFoundError();
}

/**
 * Hard-delete a project (AC-155). Distinguishes three outcomes:
 *   - Row does not exist                → ProjectNotFoundError
 *   - Row exists but `deleted = false`  → ProjectNotArchivedError
 *   - Row exists and `deleted = true`   → deletes the row; resolves
 *
 * `project_workers` rows cascade via the FK (`onDelete: 'cascade'` in
 * the schema), so no explicit cleanup is needed here.
 *
 * The two-step fetch-then-delete is deliberate: a single DELETE
 * gated by `deleted = true` would collapse the not-found and
 * not-archived cases into the same zero-rows-affected signal, and
 * the service layer must return different HTTP codes for each.
 */
export async function hardDeleteProject(db: MutatingDatabase, id: string): Promise<void> {
  const existing = await db
    .select({ id: projects.id, deleted: projects.deleted })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (existing.length === 0) throw new ProjectNotFoundError();
  if (!existing[0]!.deleted) throw new ProjectNotArchivedError();

  await db.delete(projects).where(eq(projects.id, id));
}

/**
 * Hard-delete a project by id without any archived/existence checks.
 * Caller is responsible for verifying the row is safe to drop — used
 * by `CustomerService.deleteCustomer` when atomically purging every
 * archived project referenced by the customer being deleted.
 */
export async function hardDeleteProjectUnchecked(db: MutatingDatabase, id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}
