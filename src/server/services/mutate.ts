/**
 * Single-write-path audit helper — ADR-0021.
 *
 * Every domain-entity mutation routes through `mutate()` so that the
 * state change and its `audit_log` row commit in one transaction
 * (AC-177). A mutation without its audit row is not possible; an audit
 * row without its state change is not possible.
 *
 * Shape:
 *
 *   await mutate(db, ctx, {
 *     entityType: 'project',
 *     action: 'update',
 *     run: async (tx) => {
 *       const before = await readCurrent(tx, id);
 *       const after  = await applyPatch(tx, id, patch);
 *       return { entityId: id, value: after, before, after };
 *     },
 *   });
 *
 * The service owns `before`/`after` capture because only the service
 * knows the shape of the changed fields. For creates, services set
 * `before = {}`; for deletes, `after = {}`. Server-managed timestamps
 * may appear in the payload — the spec is deliberately loose on this
 * (data-model.md §5.10 pins "changed fields only", not a strict field
 * set).
 *
 * Post-commit dispatch:
 *   After the domain transaction commits, `mutate()` hands the audit
 *   row to `audit-publisher.dispatch()`. Subscriber failures are caught
 *   by the publisher and do not surface to the caller (AC-183).
 *
 * Security: `ctx.actorId` is authoritative — routes derive it from the
 * authenticated `AuthUser`, never from a request body. The DB's compound
 * CHECK constraint enforces the actor_kind/actor_id/actor_reason
 * invariant regardless.
 */

import type { Database, MutatingDatabase } from '../db/connection.js';
import type { AuditEntityType } from '../db/schema.js';
import { auditLog } from '../db/schema.js';
import { dispatch, type AuditLogRow } from './audit-publisher.js';
import type { AuditAction } from '../../config/auditActionLabels.js';

/**
 * The actor context for a mutation.
 *
 *   - actorKind='user'   → actorId required (the authenticated caller),
 *                          actorReason MUST be null.
 *   - actorKind='system' → actorId MUST be null, actorReason MUST be a
 *                          non-empty string naming the code path
 *                          (e.g. 'first-run-bootstrap').
 *
 * correlationId is the Fastify request id (or null for unattended
 * writes such as bootstrap). Threaded through the service chain as a
 * typed argument — services never read Fastify types directly.
 */
export interface MutateContext {
  actorKind: 'user' | 'system';
  actorId?: string | null;
  actorReason?: string | null;
  correlationId?: string | null;
}

/**
 * The description of a single mutation. `run` executes the domain-side
 * work against the transaction handle and returns enough information
 * for `mutate()` to write the audit row.
 */
export interface MutateSpec<T> {
  entityType: AuditEntityType;
  /**
   * One of the pinned action keys from `auditActionLabels.ts` — the DB
   * column is free-text by design (data-model.md §5.10) but the write
   * path is closed over the shipping vocabulary. A new action lands by
   * extending `AUDIT_ACTION_KEYS`; a caller passing an unpinned string
   * fails at compile time rather than quietly producing an unlabelled
   * entry in the feed.
   */
  action: AuditAction;
  /**
   * The callback receives the transactional handle so all repository
   * reads and writes inside `run` are part of the same transaction as
   * the audit row. `entityId` is returned from the callback because
   * create mutations do not know the id until after the INSERT.
   *
   * For `before`/`after`:
   *   - Create: `before` defaults to `{}`; `after` carries the persisted
   *     non-server-managed fields.
   *   - Update: `before` and `after` carry only the changed field set
   *     (the caller diffs).
   *   - Delete/Purge: `after` defaults to `{}`; `before` carries the
   *     pre-delete row.
   *   - Transition: `before` and `after` carry `status` and
   *     `statusChangedAt`.
   */
  run: (tx: MutatingDatabase) => Promise<MutateResult<T>>;
}

export interface MutateResult<T> {
  entityId: string;
  value: T;
  before?: unknown;
  after?: unknown;
}

/**
 * The signature pinned by ADR-0021 §Decision: open transaction, run the
 * mutation callback, write the audit row, commit, then dispatch.
 *
 * Concurrency: relies on Postgres default isolation (READ COMMITTED).
 * `payload.before` reflects the row read inside this transaction before
 * the write. Concurrent writers produce their own serialized audit rows
 * (AC-177). A write-after-write race on the same row can leave a stale
 * `before` in the loser's log entry — acceptable per the audit contract
 * which pins per-transaction observation, not global serialisability.
 * Upgrade to REPEATABLE READ if stricter semantics become load-bearing.
 *
 * Return value is whatever the service callback returned in `value`.
 */
export async function mutate<T>(db: Database, ctx: MutateContext, spec: MutateSpec<T>): Promise<T> {
  // `validateContext` runs inside `mutateInTx` — no need to duplicate it
  // here. The earlier outer call was defensive but also a lie: it implied
  // that the context was pre-validated before the transaction, when in
  // fact it was re-checked on every path.

  // Both the domain work and the audit insert run inside the same
  // transaction. A throw anywhere below rolls back both; that is the
  // AC-177 atomicity invariant. We capture the returned audit row so
  // we can hand it to the publisher after commit.
  const { value, auditRow } = await db.transaction(async (tx) => {
    const { value: domainValue, auditRow: row } = await mutateInTx(tx, ctx, spec);
    return { value: domainValue, auditRow: row };
  });

  // Post-commit dispatch. `dispatch()` swallows subscriber exceptions
  // (AC-183), so we do NOT wrap this in try/catch here — the contract
  // is already fulfilled inside the publisher and wrapping again would
  // hide a dispatch-internal bug.
  await dispatch(auditRow);

  return value;
}

/**
 * Variant that runs against an already-open transaction handle. Used
 * when multiple audit-worthy sub-mutations must commit atomically (e.g.
 * update-project where a worker-list change emits one row per add/remove
 * alongside a project-level update row). Returns both the domain value
 * and the audit row — the caller is responsible for dispatching rows to
 * the publisher AFTER the outer transaction commits.
 *
 * Use `mutate()` when the mutation is standalone; use `mutateInTx()`
 * only to coordinate multi-audit-row commits.
 */
export async function mutateInTx<T>(
  tx: MutatingDatabase,
  ctx: MutateContext,
  spec: MutateSpec<T>,
): Promise<{ value: T; auditRow: AuditLogRow }> {
  validateContext(ctx);

  const domainResult = await spec.run(tx);

  const payload = {
    before: domainResult.before ?? {},
    after: domainResult.after ?? {},
  };

  const rows = await tx
    .insert(auditLog)
    .values({
      actorId: ctx.actorKind === 'user' ? (ctx.actorId ?? null) : null,
      actorKind: ctx.actorKind,
      actorReason: ctx.actorKind === 'system' ? (ctx.actorReason ?? null) : null,
      entityType: spec.entityType,
      entityId: domainResult.entityId,
      action: spec.action,
      // Drizzle's `jsonb()` column serializes the JS value automatically
      // via the pg driver. The earlier `sql\`${JSON.stringify(...)}::jsonb\``
      // wrapper duplicated that work and produced a different path into
      // the driver (parameterized literal vs SQL fragment), which masked
      // a latent issue with embedded single quotes in payload strings.
      payload,
      correlationId: ctx.correlationId ?? null,
    })
    .returning();

  const inserted = rows[0];
  if (!inserted) {
    throw new Error('mutateInTx(): audit_log insert returned no rows');
  }

  const publicRow: AuditLogRow = {
    id: inserted.id,
    createdAt: inserted.createdAt,
    actorId: inserted.actorId,
    actorKind: inserted.actorKind as 'user' | 'system',
    actorReason: inserted.actorReason,
    entityType: inserted.entityType as AuditEntityType,
    entityId: inserted.entityId,
    action: inserted.action,
    payload: inserted.payload,
    correlationId: inserted.correlationId,
  };

  return { value: domainResult.value, auditRow: publicRow };
}

/**
 * Dispatch a batch of audit rows to the publisher. Intended to be
 * invoked after an outer transaction commits, typically pairing with
 * `mutateInTx()` calls accumulated inside the transaction.
 */
export async function dispatchAuditRows(rows: AuditLogRow[]): Promise<void> {
  for (const row of rows) {
    await dispatch(row);
  }
}

function validateContext(ctx: MutateContext): void {
  // Keep these invariants enforced at the service layer even though the
  // DB CHECK enforces the same. Client-side detection gives a cleaner
  // stack trace for programmer-error cases (missing actorId on a user
  // write, etc.) than a 23514 at commit time.
  if (ctx.actorKind === 'user') {
    if (!ctx.actorId) {
      throw new Error("mutate(): actorKind='user' requires a non-empty actorId");
    }
    if (ctx.actorReason && ctx.actorReason.length > 0) {
      throw new Error("mutate(): actorKind='user' must not carry an actorReason");
    }
  } else if (ctx.actorKind === 'system') {
    if (ctx.actorId) {
      throw new Error("mutate(): actorKind='system' must not carry an actorId");
    }
    if (!ctx.actorReason || ctx.actorReason.trim().length === 0) {
      throw new Error("mutate(): actorKind='system' requires a non-empty actorReason");
    }
  } else {
    throw new Error(`mutate(): unknown actorKind '${ctx.actorKind as string}'`);
  }
}
