/**
 * Invoice repository — read-side helpers.
 *
 * Reads only. Writes ride through `InvoiceService` directly so the
 * audit + transaction boundary lives at the service layer (every
 * invoice mutation is single-write via `mutate()` / `mutateInTx()` —
 * ADR-0021 / ADR-0026 §Audit and realtime).
 *
 * Worker exclusion follows ADR-0019: there is no `project_worker` scope
 * path on invoices, so the worker predicate returns the empty set on
 * the list query and rejects the `getInvoice` path before the row read
 * — defense in depth against the route-layer permission gate (AC-298).
 */

import { eq, and, desc, asc, inArray, count, sql, type SQL } from 'drizzle-orm';
import type { Database, TransactionalDatabase } from '../db/connection.js';
import { invoices, projects } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import { isUnscoped, OUT_OF_SCOPE, type ScopedReadResult } from './scope.js';
import {
  formatInvoiceNumber,
  INVOICE_SEQUENCE_KINDS,
  type Invoice,
  type InvoiceLine,
  type InvoiceIssuerSnapshot,
  type InvoiceRecipientSnapshot,
  type InvoiceTotals,
  type InvoiceStatus,
  type InvoiceProfile,
  type TaxMode,
  type InvoiceSequenceKind,
} from '../../domain/invoice.js';

export type InvoiceRow = typeof invoices.$inferSelect;

/** Escape LIKE-pattern metacharacters so user input is treated literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

/** ISO 8601 date string for a JS `Date` or null (yyyy-mm-dd; UTC anchor). */
function dateToIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Convert a raw `invoices` row to the API-facing `Invoice` shape. JSONB
 * columns round-trip through `unknown` from Drizzle — the column-level
 * TypeScript types in `schema.ts` use `$type<>()` on a handful of
 * columns but not on the invoice snapshots, so we cast through the
 * documented shape here. Casts are localised to this projection
 * function (the entrypoint for "raw row → wire shape").
 */
export function toInvoiceResponse(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    number: row.number,
    status: row.status as InvoiceStatus,
    projectId: row.projectId,
    cancellationOf: row.cancellationOf,
    issuer: row.issuer as InvoiceIssuerSnapshot,
    recipient: row.recipient as InvoiceRecipientSnapshot,
    lines: row.lines as InvoiceLine[],
    taxMode: row.taxMode as TaxMode,
    profile: row.profile as InvoiceProfile,
    totals: row.totals as InvoiceTotals,
    issueDate: dateToIso(row.issueDate),
    performanceDate: dateToIso(row.performanceDate),
    cancellationReason: row.cancellationReason,
    renderedPdfBinaryDescriptorId: row.renderedPdfBinaryDescriptorId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

export interface ListInvoicesOpts {
  offset?: number;
  limit?: number;
  status?: InvoiceStatus;
  year?: number;
  projectId?: string;
  customerId?: string;
  /** Default `true` — when false, hide `status = 'cancelled'` originals. */
  includeCancelled?: boolean;
  search?: string;
}

/**
 * List invoices visible to the caller. Worker callers always see the
 * empty set (AC-298, AT-119) — the scope predicate has no
 * `project_worker` path on the invoice row, so the worker branch
 * short-circuits before issuing the SELECT.
 *
 * Ordering: `issueDate DESC, createdAt DESC, id` (api.md §14.2.14). Drafts
 * have null `issueDate` and sort by `createdAt DESC` via NULLS LAST.
 *
 * Search matches `number` and the snapshotted `recipient.name` (JSONB
 * extraction).
 */
export async function listInvoices(
  db: Database,
  caller: AuthUser,
  opts: ListInvoicesOpts = {},
): Promise<{ data: Invoice[]; total: number }> {
  // Worker scope: no path to any invoice (ADR-0019). The defense-in-
  // depth predicate returns an empty list regardless of opts.
  if (!isUnscoped(caller)) {
    return { data: [], total: 0 };
  }

  const conditions: SQL[] = [];
  if (opts.status) conditions.push(eq(invoices.status, opts.status));
  if (opts.year !== undefined) {
    // `EXTRACT(YEAR FROM issue_date)` works on the persisted issue date
    // but is null for drafts; the route documents `year` as a filter
    // that only matches issued/cancelled rows, which is what consumers
    // expect when bookkeeping by year.
    conditions.push(sql`EXTRACT(YEAR FROM ${invoices.issueDate}) = ${opts.year}`);
  }
  if (opts.projectId) conditions.push(eq(invoices.projectId, opts.projectId));
  if (opts.includeCancelled === false) {
    // Hide originals only — Stornos are surfaced regardless (they are
    // their own document for the auditor).
    conditions.push(
      sql`NOT (${invoices.status} = 'cancelled' AND ${invoices.cancellationOf} IS NULL)`,
    );
  }
  if (opts.search) {
    const pattern = `%${escapeLike(opts.search)}%`;
    conditions.push(
      sql`(${invoices.number} ILIKE ${pattern}
           OR ${invoices.recipient}->>'name' ILIKE ${pattern})`,
    );
  }

  let customerProjectIds: string[] | null = null;
  if (opts.customerId) {
    // Resolve the customer's project ids first so the SELECT has the
    // same shape as the project-scoped path. Single round-trip; the
    // customer surface is bounded.
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.customerId, opts.customerId));
    customerProjectIds = rows.map((r) => r.id);
    if (customerProjectIds.length === 0) {
      return { data: [], total: 0 };
    }
    conditions.push(inArray(invoices.projectId, customerProjectIds));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderBy = [
    sql`${invoices.issueDate} DESC NULLS LAST`,
    desc(invoices.createdAt),
    asc(invoices.id),
  ];

  const baseQuery = whereClause
    ? db
        .select()
        .from(invoices)
        .where(whereClause)
        .orderBy(...orderBy)
    : db
        .select()
        .from(invoices)
        .orderBy(...orderBy);
  const paginated =
    opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery;
  const countQuery = whereClause
    ? db.select({ value: count() }).from(invoices).where(whereClause)
    : db.select({ value: count() }).from(invoices);

  const [rows, countResult] = await Promise.all([paginated, countQuery]);
  return {
    data: rows.map(toInvoiceResponse),
    total: countResult[0]?.value ?? 0,
  };
}

/**
 * Get an invoice by id with the worker-exclusion three-way semantic
 * (AC-298 — `null` / OUT_OF_SCOPE / row), mirroring the project-scope
 * policy (AC-147).
 *
 * The row exists check runs before the scope check so we don't leak
 * row existence to a worker via the response code shape.
 */
export async function getInvoice(
  db: Database,
  caller: AuthUser,
  id: string,
): Promise<ScopedReadResult<Invoice>> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (rows.length === 0) return null;
  if (!isUnscoped(caller)) return OUT_OF_SCOPE;
  return toInvoiceResponse(rows[0]!);
}

/**
 * Fetch a raw invoice row inside a transaction. Used by the service
 * layer to read `payload.before` inside the same snapshot as the
 * mutation. Returns null on miss; callers map to `NOT_FOUND`.
 */
export async function getInvoiceRowForMutation(
  tx: TransactionalDatabase,
  id: string,
): Promise<InvoiceRow | null> {
  const rows = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Count issued + cancelled invoice rows for a given project. Drafts are
 * excluded by construction (AC-307 / AC-308): drafts cascade-delete and
 * have no legal weight. Returns 0 when the project carries no invoices.
 */
export async function countIssuedOrCancelledForProject(
  db: TransactionalDatabase,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(invoices)
    .where(
      and(eq(invoices.projectId, projectId), inArray(invoices.status, ['issued', 'cancelled'])),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Count issued + cancelled invoice rows across a customer's project
 * graph (active + archived). AC-307: drives the customer-delete reject
 * decision and the `invoiceCount` exposed on the customer GET response.
 */
export async function countIssuedOrCancelledForCustomer(
  db: TransactionalDatabase,
  customerId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(invoices)
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .where(
      and(eq(projects.customerId, customerId), inArray(invoices.status, ['issued', 'cancelled'])),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Allocate the next value in the gapless `(year, kind)` sequence inside
 * the supplied transaction (data-model.md §6.13). Implementation pattern:
 *
 *   1. `SELECT … FOR UPDATE` on the matching row.
 *   2. If the row exists, increment `next_value` and RETURNING the
 *      pre-increment value (the one we hand out).
 *   3. If the row does not exist (first allocation of the year/kind),
 *      INSERT a fresh row at `next_value = 2` and hand out 1.
 *
 * The `FOR UPDATE` lock is held until the transaction commits — a
 * rollback returns the value to the sequence (AC-288 gapless guarantee).
 *
 * Caller passes the year and kind; the formatted string is built at the
 * call site via `formatInvoiceNumber`. Returns the integer suffix value.
 */
export async function allocateNextSequenceValue(
  tx: TransactionalDatabase,
  year: number,
  kind: InvoiceSequenceKind,
): Promise<number> {
  // Validate at the boundary — defense against a programming error
  // landing a non-pinned `kind` and falling through to a free-text
  // INSERT against the CHECK constraint.
  if (!INVOICE_SEQUENCE_KINDS.includes(kind)) {
    throw new Error(`allocateNextSequenceValue: invalid kind ${String(kind)}`);
  }

  // Try to lock-and-update an existing row. The `UPDATE … RETURNING`
  // shape claims the value atomically when the row exists. Drizzle does
  // not have first-class FOR UPDATE on UPDATE, but UPDATE itself takes
  // a row lock equivalent to `SELECT FOR UPDATE` on the matching
  // primary key — the gapless invariant holds because the lock is
  // released only at transaction commit / rollback.
  const updated = await tx.execute(
    sql`UPDATE invoice_sequence
           SET next_value = next_value + 1,
               updated_at = NOW()
         WHERE year = ${year} AND kind = ${kind}
         RETURNING next_value`,
  );

  if (updated.rows.length > 0) {
    // The returned `next_value` is the POST-increment value. The value
    // we hand out is one less.
    const post = Number((updated.rows[0] as { next_value: string | number }).next_value);
    return post - 1;
  }

  // First allocation of (year, kind). INSERT the seed row at
  // next_value = 2 and hand out 1. The INSERT itself takes a row-level
  // lock on the new row inside the transaction; a concurrent first-
  // allocation racer's INSERT hits the PK and blocks until commit — a
  // ROLLBACK frees the slot, a COMMIT means the racer flips to the
  // UPDATE branch on the next attempt.
  await tx.execute(
    sql`INSERT INTO invoice_sequence (year, kind, next_value)
        VALUES (${year}, ${kind}, 2)`,
  );
  return 1;
}

/**
 * Convenience — allocate + format in one call. Returns the canonical
 * `RE-YYYY-NNNN` / `ST-YYYY-NNNN` string.
 */
export async function allocateInvoiceNumber(
  tx: TransactionalDatabase,
  year: number,
  kind: InvoiceSequenceKind,
): Promise<{ value: number; number: string }> {
  const value = await allocateNextSequenceValue(tx, year, kind);
  return { value, number: formatInvoiceNumber(kind, year, value) };
}
