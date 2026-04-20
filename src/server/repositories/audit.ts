/**
 * Audit-log repository — read-only (api.md §14.2.8).
 *
 * The audit surface is append-only (data-model.md §5.10); no create,
 * update, or delete path is exposed. Writes happen exclusively through
 * the service-layer `mutate()` helper.
 *
 * Scope composition follows the ADR-0019 pattern: the repository
 * applies one `WHERE` fragment — destructive-action narrowing — ANDed
 * with filters into the list query, and the same fragment decides
 * in-scope vs out-of-scope for get-by-id. An earlier revision carried
 * a second fragment (worker reachability); it was dropped when
 * workers lost `audit:read`.
 *
 * Deterministic ordering: `created_at DESC, id DESC` — the stable
 * tiebreaker ensures a second fetch with the same filters returns
 * the same page (api.md §14.1).
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { auditLog, users } from '../db/schema.js';
import type { AuditEntityType } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import { auditDestructiveScopeForCaller, OUT_OF_SCOPE, type ScopedReadResult } from './scope.js';

/**
 * Joined audit row shape returned from the repository, before the
 * service-layer redacts it per role. Carries the raw DB column values
 * plus the joined actor display name (when the actor is a user).
 *
 * The service layer decides what to expose to each caller — the
 * repository returns the full set so both unscoped and scoped read
 * paths share one query shape.
 */
export interface AuditRow {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorKind: 'user' | 'system';
  actorReason: string | null;
  entityType: AuditEntityType;
  entityId: string;
  /** Snapshot of the entity's human-readable label at write time. */
  entityLabel: string | null;
  action: string;
  payload: unknown;
  correlationId: string | null;
  /** null when `actorKind='system'` or the actor user has been hard-deleted. */
  actorDisplayName: string | null;
}

export interface ListAuditOpts {
  offset?: number;
  limit?: number;
  entityType?: AuditEntityType;
  entityId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  action?: string;
}

/** Re-exported so route-layer schema validation pins the same set. */
export { AUDIT_ENTITY_TYPES } from '../db/schema.js';

/**
 * List audit entries visible to the caller.
 *
 * Filters AND-compose; `auditDestructiveScopeForCaller` narrows
 * office visibility (purges / user deletes / role changes are owner-
 * only). Owner gets a null predicate (unfiltered).
 */
export async function listAuditEntries(
  db: Database,
  caller: AuthUser,
  opts: ListAuditOpts,
): Promise<{ rows: AuditRow[]; total: number }> {
  const conditions: SQL[] = [];

  if (opts.entityType !== undefined) {
    conditions.push(eq(auditLog.entityType, opts.entityType));
  }
  if (opts.entityId !== undefined) {
    conditions.push(eq(auditLog.entityId, opts.entityId));
  }
  if (opts.actorId !== undefined) {
    conditions.push(eq(auditLog.actorId, opts.actorId));
  }
  if (opts.from !== undefined) {
    conditions.push(gte(auditLog.createdAt, opts.from));
  }
  if (opts.to !== undefined) {
    conditions.push(lte(auditLog.createdAt, opts.to));
  }
  if (opts.action !== undefined) {
    conditions.push(eq(auditLog.action, opts.action));
  }

  const destructive = auditDestructiveScopeForCaller(caller);
  if (destructive) conditions.push(destructive);

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Join users LEFT so rows with actor_id=null (system) or with a
  // hard-deleted actor still appear. The service layer decides whether
  // to expose display_name to the caller.
  const baseSelect = db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorId: auditLog.actorId,
      actorKind: auditLog.actorKind,
      actorReason: auditLog.actorReason,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      entityLabel: auditLog.entityLabel,
      action: auditLog.action,
      payload: auditLog.payload,
      correlationId: auditLog.correlationId,
      actorDisplayName: users.displayName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId));

  const orderedQuery = whereClause
    ? baseSelect.where(whereClause).orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    : baseSelect.orderBy(desc(auditLog.createdAt), desc(auditLog.id));

  const paginated =
    opts.limit !== undefined
      ? orderedQuery.limit(opts.limit).offset(opts.offset ?? 0)
      : orderedQuery;

  const countQuery = whereClause
    ? db
        .select({ value: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(whereClause)
    : db.select({ value: sql<number>`count(*)::int` }).from(auditLog);

  const [rows, countResult] = await Promise.all([paginated, countQuery]);
  const total = countResult[0]?.value ?? 0;

  return {
    rows: rows.map(toAuditRow),
    total,
  };
}

/**
 * Get an audit entry by id, respecting caller scope.
 *
 * Three-valued result (ADR-0019):
 *   - `null`         — row does not exist (→ 404 NOT_FOUND)
 *   - `OUT_OF_SCOPE` — row exists but caller's scope excludes it
 *                      (→ 403 NOT_PERMITTED)
 *   - `AuditRow`     — in-scope row
 *
 * The two-step fetch (id lookup, then scope check with both predicates)
 * is deliberate: one combined query cannot distinguish "not found" from
 * "out of scope" post-hoc, and collapsing them would leak existence via
 * absence (parity with AC-147 for the per-entity surface).
 */
export async function getAuditEntry(
  db: Database,
  caller: AuthUser,
  id: string,
): Promise<ScopedReadResult<AuditRow>> {
  const baseQuery = db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorId: auditLog.actorId,
      actorKind: auditLog.actorKind,
      actorReason: auditLog.actorReason,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      entityLabel: auditLog.entityLabel,
      action: auditLog.action,
      payload: auditLog.payload,
      correlationId: auditLog.correlationId,
      actorDisplayName: users.displayName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(eq(auditLog.id, id))
    .limit(1);

  const rows = await baseQuery;
  if (rows.length === 0) return null;

  // Scope check: the row exists; re-run the destructive predicate to
  // catch office-visibility narrowing (purges / user-deletes etc.).
  // Owner gets null (unfiltered). A tiny lookup query is cheaper than
  // evaluating the jsonb predicates in application code.
  const destructive = auditDestructiveScopeForCaller(caller);
  if (destructive !== null) {
    const check = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.id, id), destructive))
      .limit(1);
    if (check.length === 0) return OUT_OF_SCOPE;
  }

  return toAuditRow(rows[0]!);
}

function toAuditRow(row: {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorKind: string;
  actorReason: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  action: string;
  payload: unknown;
  correlationId: string | null;
  actorDisplayName: string | null;
}): AuditRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: row.actorKind as 'user' | 'system',
    actorReason: row.actorReason,
    entityType: row.entityType as AuditEntityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    action: row.action,
    payload: row.payload,
    correlationId: row.correlationId,
    actorDisplayName: row.actorDisplayName,
  };
}
