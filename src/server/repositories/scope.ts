/**
 * Role-based read-scope predicates.
 *
 * Per ADR-0019, scope is orthogonal to permissions. A caller's `project:read`
 * or `customer:read` grants the *capability* to read; these predicates narrow
 * the *extent* — which rows they're allowed to see — as a SQL `WHERE`
 * fragment ANDed into repository queries.
 *
 * The predicate is a pure, total function of the caller's identity,
 * classified by `ROLE_CLASSIFICATION` below:
 *   - unscoped roles → `null` (no additional filter)
 *   - scoped roles   → EXISTS (...) fragment scoped via project_workers
 *
 * Bookkeeper is classified as unscoped as an MVP placeholder (ADR-0019, to
 * be revisited when the invoice-oriented view is introduced).
 *
 * Returning `null` for unscoped callers is load-bearing: callers AND it into
 * a conditions list, and drizzle's `and(cond, undefined)` collapses to `cond`
 * — so a single code path handles both scoped and unscoped queries.
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import type { Role } from '../../config/permissions.js';

/**
 * Single-source classification of every `Role`. A new `Role` variant forces
 * an update to this map — otherwise `tsc` errors with a missing key. That
 * guarantees we cannot silently add a role that's neither explicitly scoped
 * nor explicitly unscoped (prior `UNSCOPED_ROLES` Set missed this: adding a
 * role would simply fall into the scoped branch without a type-level
 * warning).
 */
const ROLE_CLASSIFICATION: Record<Role, 'scoped' | 'unscoped'> = {
  owner: 'unscoped',
  office: 'unscoped',
  worker: 'scoped',
  bookkeeper: 'unscoped',
};

/** Roles whose reads ARE constrained by scope. Derived from the map above. */
const SCOPED_ROLES: ReadonlySet<Role> = new Set<Role>(
  (Object.entries(ROLE_CLASSIFICATION) as [Role, 'scoped' | 'unscoped'][])
    .filter(([, classification]) => classification === 'scoped')
    .map(([role]) => role),
);

/**
 * A caller is unscoped iff none of their roles is classified as scoped.
 *
 * Exported so scope-bypassing services (e.g. ExportService) can fail-fast
 * when a scoped caller is threaded in — see ADR-0019.
 */
export function isUnscoped(user: AuthUser): boolean {
  return !user.roles.some((role) => SCOPED_ROLES.has(role as Role));
}

/**
 * Scope fragment for project reads.
 *
 * Unscoped roles (owner, office, bookkeeper) → null (no filter).
 * Scoped roles (worker) → EXISTS subquery that requires the caller to be
 *   recorded in `project_workers` for the `projects.id` of the outer row.
 *
 * A caller with no unscoped role falls into the scoped branch. The
 * `requirePermission` preHandler has already rejected anyone lacking
 * `project:read`, so this branch runs only for legitimate scoped callers.
 */
export function projectScopeForCaller(user: AuthUser): SQL | null {
  if (isUnscoped(user)) return null;
  return sql`EXISTS (
    SELECT 1 FROM project_workers pw
    WHERE pw.project_id = projects.id
      AND pw.user_id = ${user.id}
  )`;
}

/**
 * Scope fragment for customer reads.
 *
 * Unscoped roles (owner, office, bookkeeper) → null.
 * Scoped roles (worker) → customer is visible iff at least one non-deleted
 *   project references it AND the caller is assigned to that project.
 *
 * Soft-deleted projects do not make their customers visible to scoped
 * callers, matching AC-146. Unscoped callers are unaffected — `deleted`
 * projects do not restrict their customer list.
 */
export function customerScopeForCaller(user: AuthUser): SQL | null {
  if (isUnscoped(user)) return null;
  return sql`EXISTS (
    SELECT 1 FROM projects p
    INNER JOIN project_workers pw ON pw.project_id = p.id
    WHERE p.customer_id = customers.id
      AND p.deleted = FALSE
      AND pw.user_id = ${user.id}
  )`;
}

/**
 * Three-valued get-by-id result.
 *
 *   - `null`                 — row does not exist (→ 404 NOT_FOUND)
 *   - `{ outOfScope: true }` — row exists but caller's scope excludes it
 *                              (→ 403 NOT_PERMITTED per AC-147/AC-148)
 *   - `T`                    — in-scope row
 *
 * Representing out-of-scope as a discriminated shape (rather than throwing)
 * keeps the repository free of handler concerns and lets TypeScript's
 * narrowing distinguish all three outcomes at the call site.
 *
 * See ADR-0019 for the rationale behind 403-over-404.
 */
export const OUT_OF_SCOPE = { outOfScope: true } as const;
export type OutOfScope = typeof OUT_OF_SCOPE;
export type ScopedReadResult<T> = T | OutOfScope | null;

export function isOutOfScope<T>(result: ScopedReadResult<T>): result is OutOfScope {
  return result !== null && typeof result === 'object' && 'outOfScope' in result;
}

/**
 * Run a scope check for a known-existing project id.
 *
 * The repository's get-by-id path fetches the row WITHOUT the scope fragment
 * (so existence is decidable), then calls this helper to decide in-scope vs
 * out-of-scope. A tiny lookup query is cheaper than re-doing the original
 * fetch with the scope ANDed in and trying to distinguish "no row because
 * missing" from "no row because out-of-scope" post-hoc.
 */
export async function isProjectInScope(
  db: Database,
  user: AuthUser,
  projectId: string,
): Promise<boolean> {
  if (isUnscoped(user)) return true;
  const result = await db.execute(
    sql`SELECT 1 FROM project_workers
        WHERE project_id = ${projectId}
          AND user_id = ${user.id}
        LIMIT 1`,
  );
  return result.rows.length > 0;
}

/**
 * Run a scope check for a known-existing customer id.
 *
 * Worker callers see the customer iff it is referenced by at least one
 * non-deleted project where the worker is assigned.
 */
export async function isCustomerInScope(
  db: Database,
  user: AuthUser,
  customerId: string,
): Promise<boolean> {
  if (isUnscoped(user)) return true;
  const result = await db.execute(
    sql`SELECT 1 FROM projects p
        INNER JOIN project_workers pw ON pw.project_id = p.id
        WHERE p.customer_id = ${customerId}
          AND p.deleted = FALSE
          AND pw.user_id = ${user.id}
        LIMIT 1`,
  );
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------
// Audit-log scope predicates — ADR-0019 pattern + AC-180/AC-182/AC-187
// ---------------------------------------------------------------------
//
// The audit surface has TWO orthogonal predicates (api.md §14.2.8):
//
//   1. auditReachabilityScopeForCaller(user)
//        Worker reachability: project/customer/project_worker entries
//        reachable through the caller's assignment graph, plus the
//        self-authorship carve-out for user-entity rows authored by
//        the caller themselves (AC-180).
//
//   2. auditDestructiveScopeForCaller(user)
//        Destructive-action visibility: only the owner sees audit
//        entries for purge / user-delete / user-roles-update (AC-182,
//        AC-187).
//
// The two fragments AND-compose with `audit:read` — permissions stay
// coarse; scope is orthogonal to capability (ADR-0019 §Decision).

/**
 * Scope fragment for audit reads — reachability half.
 *
 * Owner / office → null (no reachability filter).
 * Worker → SQL fragment admitting entries that are either:
 *   - `project` with entity_id in the caller's assigned-project set, OR
 *   - `customer` with entity_id among customers reached via a non-deleted
 *     assigned project, OR
 *   - `project_worker` whose payload references a project in the caller's
 *     assignment set (either `before.projectId` or `after.projectId`), OR
 *   - `user` authored by the caller themselves (self-authorship — AC-180).
 * Bookkeeper: classified as unscoped via ROLE_CLASSIFICATION, but the
 * audit permission matrix already excludes bookkeeper from `audit:read`
 * (api.md §14.3), so the bookkeeper branch is never reached. Kept
 * returning null to match the other unscoped roles — a bookkeeper who
 * somehow held `audit:read` in a misconfigured deployment would at least
 * not leak under the reachability half; the destructive predicate still
 * filters.
 *
 * Index alignment: `audit_log_entity_idx` is on `(entity_type, entity_id,
 * created_at DESC)` — the equality-then-IN access pattern in each arm is
 * covered. The `project_worker` arm uses `payload->'...'->>'projectId'`,
 * which is NOT index-covered today; worker-scope lists rely on the
 * reachability AND destructive predicates combined, so the total scan is
 * bounded by the worker's project_workers cardinality in practice. If
 * this becomes a hot path, consider a functional index on the extracted
 * projectId or materialize it as a column.
 */
export function auditReachabilityScopeForCaller(user: AuthUser): SQL | null {
  if (isUnscoped(user)) return null;
  return sql`(
    (audit_log.entity_type = 'project' AND audit_log.entity_id IN (
      SELECT pw.project_id FROM project_workers pw WHERE pw.user_id = ${user.id}
    ))
    OR (audit_log.entity_type = 'customer' AND audit_log.entity_id IN (
      SELECT DISTINCT p.customer_id
        FROM projects p
        INNER JOIN project_workers pw ON pw.project_id = p.id
       WHERE pw.user_id = ${user.id} AND p.deleted = FALSE
    ))
    OR (audit_log.entity_type = 'project_worker' AND (
      (audit_log.payload->'before'->>'projectId')::uuid IN (
        SELECT pw.project_id FROM project_workers pw WHERE pw.user_id = ${user.id}
      )
      OR (audit_log.payload->'after'->>'projectId')::uuid IN (
        SELECT pw.project_id FROM project_workers pw WHERE pw.user_id = ${user.id}
      )
    ))
    OR (audit_log.entity_type = 'user' AND audit_log.actor_id = ${user.id})
  )`;
}

/**
 * Scope fragment for audit reads — destructive-action half.
 *
 * Owner → null (no destructive filter; owner sees every row).
 * Every other role (office, worker, bookkeeper) → SQL fragment EXCLUDING:
 *   - `action = 'purge'` (any entity_type), AND
 *   - `action = 'delete'` on `entity_type = 'user'`, AND
 *   - `action = 'update'` on `entity_type = 'user'` where the payload diff
 *     touches `roles`.
 *
 * The `?` operator is Postgres's jsonb key-existence test; it returns true
 * when the key is present regardless of its value (including null).
 *
 * The predicate keys off the action + entity_type + payload shape, not on
 * permissions — "destructive visibility" is orthogonal to `audit:read`
 * (ADR-0019 reaffirmed in api.md §14.3 design notes).
 */
export function auditDestructiveScopeForCaller(user: AuthUser): SQL | null {
  // Owner is the sole role that bypasses the destructive filter. Every
  // other role — including unscoped office and bookkeeper — sees the
  // destructive narrowing. We check role membership directly rather than
  // reusing `isUnscoped()` because destructive-visibility is a role-axis
  // concern, not a reachability one.
  if (user.roles.some((role) => role === 'owner')) return null;
  return sql`NOT (
    audit_log.action = 'purge'
    OR (audit_log.action = 'delete' AND audit_log.entity_type = 'user')
    OR (audit_log.action = 'update' AND audit_log.entity_type = 'user'
        AND (audit_log.payload->'before' ? 'roles' OR audit_log.payload->'after' ? 'roles'))
  )`;
}
