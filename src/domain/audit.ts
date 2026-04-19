/**
 * Audit-log domain types (frontend view).
 *
 * Mirrors the API-facing `AuditEntry` contract from `api.md §14.2.8`
 * and `data-model.md §5.10`. Pure types + type guards — no state, no
 * API calls. This module is safe to import from config, state, and
 * UI layers.
 *
 * The server applies per-role response shaping (actorId / payload
 * stripping for worker callers), so every optional field below has a
 * documented "may be null" reason tied to the API contract.
 */

/**
 * Entity types that can appear as an audit row's target. Matches the
 * server-side `AuditEntityType` enum (data-model.md §5.10, see
 * `src/server/db/schema.ts`). The union is written here rather than
 * imported from the server module to respect the layering rule — the
 * domain layer must not depend on server internals.
 */
export type AuditEntityType = 'project' | 'customer' | 'user' | 'project_worker';

export type AuditActorKind = 'user' | 'system';

/**
 * One audit-log entry as returned by the API (`GET /api/audit` or
 * `GET /api/audit/:id`). Every nullable field's nullability is pinned
 * by the server contract — the client must never synthesize values.
 */
export interface AuditEntry {
  id: string;
  createdAt: string;
  /**
   * Actor identity.
   *   - owner/office callers: the actor's user id (or null for `system`).
   *   - worker callers: only set when `actorId === caller.id`; null on
   *     every other row (api.md §14.2.8 "Actor name in response").
   */
  actorId: string | null;
  actorKind: AuditActorKind;
  /** Free-text reason carried on system-actor rows. */
  actorReason: string | null;
  /**
   * Display name of the user actor. Populated server-side for owner
   * and office callers on `actorKind === 'user'` rows. Null for worker
   * callers (workers lack `user:read`). Null for system-actor rows.
   */
  actorDisplayName: string | null;
  entityType: AuditEntityType;
  entityId: string;
  /**
   * Action vocabulary — free-text by design (data-model.md §5.10). The
   * shipping set is pinned by `auditActionLabels.ts` for UI rendering;
   * filter-side validation is enforced by the server.
   */
  action: string;
  /**
   * The field-level diff payload (jsonb on the server).
   *   - owner/office callers: populated on any row the server persists
   *     a payload for.
   *   - worker callers: populated only on self-authored rows; stripped
   *     to null elsewhere (api.md §14.2.8 "Payload drawer").
   * `unknown` is deliberate — the payload's shape depends on the
   * action and entity type and is rendered by a shape-tolerant drawer.
   */
  payload: unknown | null;
  correlationId: string | null;
}

export interface AuditListResponse {
  data: AuditEntry[];
  total: number;
}

/**
 * Filter / pagination parameters accepted by `GET /api/audit`. All
 * fields are optional; inversely-ordered date bounds (`to < from`)
 * are a validation error on the server (api.md §14.2.8).
 */
export interface AuditListParams {
  offset?: number;
  limit?: number;
  entityType?: AuditEntityType;
  entityId?: string;
  actorId?: string;
  /** ISO-8601 lower bound, inclusive. */
  from?: string;
  /** ISO-8601 upper bound, inclusive. */
  to?: string;
  action?: string;
}

/**
 * Shape guard for the before/after diff used in the payload drawer.
 *
 * The server's `mutate()` helper writes payloads like
 *   `{ before: { field: value, ... }, after: { field: value, ... } }`
 * for update actions; create / delete rows carry a single-sided shape
 * (e.g. `{ after: { ... } }`). The drawer renders whichever keys are
 * present, so the guard accepts any object with at least one of the
 * two keys.
 */
export function isPayloadDiff(payload: unknown): payload is {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
} {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return 'before' in p || 'after' in p;
}
