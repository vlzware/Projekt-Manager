/**
 * Post-commit audit publisher — api.md §14.2.8.
 *
 * ADR-0021 splits the audit-write path from subscriber dispatch: the
 * `mutate()` helper writes the domain mutation and the `audit_log` row
 * in one transaction, and only after that transaction commits does the
 * helper invoke `dispatch()` here. A throwing subscriber therefore cannot
 * roll back the originating mutation — AC-183.
 *
 * Surface (pinned by api.md §14.2.8 "Post-commit publisher contract"):
 *
 *   onAuditCommitted(handler) → unsubscribe
 *     Handlers are invoked once per commit, in registration order
 *     (Set iteration order = insertion order in modern JS runtimes).
 *
 *   setOperationalLogger(logger)
 *     Wires the structured operational logger used to surface handler
 *     failures. Without this wiring, a subscriber failure is silently
 *     swallowed — the failure-surface contract (AC-183) mandates a
 *     structured log line, so production code must call this once at
 *     startup.
 *
 *   dispatch(row)
 *     Internal — called by `mutate()` after commit. Exported so tests
 *     can drive the publisher directly if needed.
 */

import type { AuditEntityType } from '../db/schema.js';

/**
 * The committed audit-log row as observed by subscribers. Shape mirrors
 * `data-model.md §5.10` — subscribers receive field-keyed diffs rather
 * than full-row snapshots.
 */
export interface AuditLogRow {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorKind: 'user' | 'system';
  actorReason: string | null;
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  payload: unknown;
  correlationId: string | null;
}

/** Subscriber function. Return value (sync or async) is ignored. */
export type AuditHandler = (row: AuditLogRow) => void | Promise<void>;

/**
 * Structured logger used to surface subscriber failures. The `error`
 * method is required; `info` is optional so deployment environments
 * that only wire an error channel still satisfy the contract.
 */
export interface OperationalLogger {
  info?: (payload: object) => void;
  error: (payload: object) => void;
}

// Module-level registry. A Set preserves insertion order in ES2015+,
// which is the registration-order guarantee api.md §14.2.8 pins.
const handlers = new Set<AuditHandler>();
let logger: OperationalLogger | null = null;

/**
 * Register a post-commit handler. Returns an unsubscribe function so
 * callers (e.g. tests) can remove their handler without hanging on to
 * a reference to the exact closure. The Set identity guarantees at-
 * most-once dispatch per commit per handler.
 */
export function onAuditCommitted(handler: AuditHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Wire the operational logger. Call once at startup. A subsequent call
 * replaces the previous logger — tests use this to inject a spy without
 * mutating the original handle.
 */
export function setOperationalLogger(l: OperationalLogger): void {
  logger = l;
}

/**
 * Invoked by `mutate()` after the transaction commits. Iterates every
 * registered handler and catches any thrown error so one bad subscriber
 * cannot prevent the next from running. Each failure surfaces through
 * the operational logger with the AC-183 field set exactly.
 */
export async function dispatch(row: AuditLogRow): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(row);
    } catch (err) {
      logger?.error({
        event: 'audit-publisher-handler-error',
        audit_entry_id: row.id,
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Test-only reset. Not part of the public spec surface but a useful
 * safety valve when tests subscribe and the vitest runner reuses the
 * module between describe blocks. Production code has no reason to
 * call this.
 */
export function __resetForTests(): void {
  handlers.clear();
  logger = null;
}
