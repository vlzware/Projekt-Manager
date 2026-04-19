/**
 * Audit service — read-only surface (api.md §14.2.8).
 *
 * Responsibilities:
 *  - Delegate scoped reads to the audit repository.
 *  - Apply per-role response shaping (api.md §14.2.8 "Actor name" and
 *    "Payload drawer" design notes):
 *      - owner / office: full payload; displayName on user-actor rows.
 *      - worker: full payload only for self-authored rows; non-self
 *        rows carry `actorId = null` and `payload = null`; no
 *        displayName (workers lack `user:read`).
 *      - system-actor rows: include `actorReason` for every role.
 *
 * Wire shape: camelCase keys, matching `data-model.md §5.10` and every
 * other API on this server.
 */

import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import {
  listAuditEntries as listAuditEntriesRepo,
  getAuditEntry as getAuditEntryRepo,
  type AuditRow,
  type ListAuditOpts,
} from '../repositories/audit.js';
import { isOutOfScope } from '../repositories/scope.js';
import { AUDIT_ENTITY_TYPES } from '../db/schema.js';

// Re-exported from the service module so route-layer schema validation
// can pin the enum without bypassing the services→repositories/db
// boundary lint rule. The canonical definition lives in `db/schema.ts`
// (data-model.md §5.10); this is a type-safe forwarding.
export { AUDIT_ENTITY_TYPES };
export type { AuditEntityType } from '../db/schema.js';

/**
 * The action vocabulary pinned by data-model.md §5.10. Kept here (not
 * in `db/schema.ts`) because the action column is free-text by design
 * — the vocabulary is a presentation-layer/filter contract, not a
 * database-schema invariant. A new action value ships first as a
 * service-layer write; adding it to this list pins the filter-side
 * vocabulary so a client cannot filter on an undocumented action.
 */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'transition:forward',
  'transition:backward',
  'purge',
  'reactivate',
  'deactivate',
  'password-reset',
  'password-change',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The API-facing audit entry shape per `data-model.md §5.10`.
 *
 * `actorDisplayName` and `payload` are conditionally present per role
 * (see class doc). Absent fields are represented as `null`, not omitted,
 * so a typed client sees a stable key set across roles.
 */
export interface AuditEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorKind: 'user' | 'system';
  actorReason: string | null;
  actorDisplayName: string | null;
  entityType: 'project' | 'customer' | 'user' | 'project_worker';
  entityId: string;
  action: string;
  payload: unknown | null;
  correlationId: string | null;
}

type AuditGetResult =
  | { status: 'found'; entry: AuditEntry }
  | { status: 'forbidden' }
  | { status: 'not-found' };

export class AuditService {
  constructor(private db: Database) {}

  async list(
    caller: AuthUser,
    opts: ListAuditOpts,
  ): Promise<{ data: AuditEntry[]; total: number }> {
    const { rows, total } = await listAuditEntriesRepo(this.db, caller, opts);
    const data = rows.map((row) => shapeEntryForCaller(row, caller));
    return { data, total };
  }

  async get(caller: AuthUser, id: string): Promise<AuditGetResult> {
    const result = await getAuditEntryRepo(this.db, caller, id);
    if (result === null) return { status: 'not-found' };
    if (isOutOfScope(result)) return { status: 'forbidden' };
    return { status: 'found', entry: shapeEntryForCaller(result, caller) };
  }
}

/**
 * Apply the per-role response shape — the sole place where `actorId`
 * masking and payload stripping happen. The input carries everything
 * the repository could fetch; the output carries only what the caller
 * is permitted to see.
 *
 * Rules (api.md §14.2.8):
 *   1. `actorReason` is always exposed when the actor is 'system' — the
 *      activity-feed copy needs the reason so the row is meaningful to
 *      any reader (AC-178 rationale).
 *   2. `actorDisplayName` is exposed only to owner/office, only for
 *      user-actor rows. Workers lack `user:read` and must not learn the
 *      display names of other users via the audit surface.
 *   3. `payload` is exposed to owner/office always. For worker callers,
 *      it is exposed only on self-authored rows; on every other row the
 *      payload is null. This matches the UI contract — workers see the
 *      human-readable activity surface for others' actions, not raw
 *      field diffs.
 *   4. Worker + non-self rows also carry `actorId = null`. Exposing the
 *      raw actor id would leak identity beyond the worker's project
 *      scope (a user id is PII in the domain).
 */
function shapeEntryForCaller(row: AuditRow, caller: AuthUser): AuditEntry {
  const isWorker = isWorkerCaller(caller);
  const isSelfAuthored = row.actorId !== null && row.actorId === caller.id;

  // Worker callers see their own actorId; on every other row we redact
  // it to null. Owner/office see the raw actorId unchanged.
  const actorId = isWorker && !isSelfAuthored ? null : row.actorId;

  // Payload strip — worker non-self rows lose the payload entirely.
  // Owner/office callers always see the full payload.
  const payload: unknown | null = isWorker && !isSelfAuthored ? null : row.payload;

  // Display name — owner/office see it for user-actor rows only.
  // Workers never receive a display name from this surface.
  const actorDisplayName = !isWorker && row.actorKind === 'user' ? row.actorDisplayName : null;

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorId,
    actorKind: row.actorKind,
    actorReason: row.actorReason,
    actorDisplayName,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    payload,
    correlationId: row.correlationId,
  };
}

/**
 * A caller is treated as a "worker" for response-shaping purposes iff
 * their role set includes `worker` AND does NOT include any more-
 * privileged role (owner / office). A user with both owner and worker
 * roles receives the owner shape — more-privileged wins.
 */
function isWorkerCaller(caller: AuthUser): boolean {
  const roles = new Set(caller.roles);
  if (roles.has('owner') || roles.has('office')) return false;
  return roles.has('worker');
}
