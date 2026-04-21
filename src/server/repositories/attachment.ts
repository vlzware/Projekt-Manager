/**
 * Attachment repository — CRUD + scope-aware reads.
 *
 * Writes take `MutatingDatabase` (a transaction handle only; see
 * `src/server/db/connection.ts`) so a caller bypassing the service-
 * layer `mutate()` helper fails at tsc — AC-179's primary build-time
 * seam (ADR-0021). Reads accept `Database | TxHandle` via the
 * `TransactionalDatabase` alias for parity with other repos.
 *
 * The `attachmentScopeForCaller` predicate in `scope.ts` lets worker-
 * visible rows narrow by `project_workers` membership (AC-217); this
 * module composes it into list / get-by-id queries.
 */

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Database, MutatingDatabase, TransactionalDatabase } from '../db/connection.js';
import { attachments } from '../db/schema.js';
import type { AttachmentKind, AttachmentLabel, AttachmentStatus } from '../../domain/types.js';
import type { AuthUser } from '../middleware/auth.js';
import { attachmentScopeForCaller } from './scope.js';

export type AttachmentRow = typeof attachments.$inferSelect;

export interface CreatePendingAttachmentInput {
  id?: string;
  projectId: string;
  kind: AttachmentKind;
  label: AttachmentLabel;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  originalKey: string;
  thumbKey: string | null;
  hasThumbnail: boolean;
  createdBy: string | null;
}

/**
 * List attachments on a project, ANDed with the caller's scope predicate
 * so a worker sees only rows on projects they are assigned to. Excludes
 * `pending` rows — the list surface in api.md §14.2.11 returns ready-only
 * rows; the service layer is responsible for that filter so repositories
 * stay composable.
 */
export async function listByProject(
  db: Database,
  projectId: string,
  caller: AuthUser,
): Promise<AttachmentRow[]> {
  const scope = attachmentScopeForCaller(caller);
  const conditions = [eq(attachments.projectId, projectId), eq(attachments.status, 'ready')];
  if (scope) conditions.push(scope);
  return db
    .select()
    .from(attachments)
    .where(and(...conditions))
    .orderBy(desc(attachments.createdAt), desc(attachments.id));
}

/**
 * Get a single attachment by id WITHOUT the scope predicate. Used by
 * the service layer's get-by-id which decides `404 / 403 / 200` with a
 * distinct scope lookup (parallel to `getProject` in `project-read.ts`).
 */
export async function getById(
  db: TransactionalDatabase,
  id: string,
): Promise<AttachmentRow | null> {
  const rows = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createPending(
  db: MutatingDatabase,
  input: CreatePendingAttachmentInput,
): Promise<AttachmentRow> {
  const rows = await db
    .insert(attachments)
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      projectId: input.projectId,
      status: 'pending',
      kind: input.kind,
      label: input.label,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      originalKey: input.originalKey,
      thumbKey: input.thumbKey,
      hasThumbnail: input.hasThumbnail,
      createdBy: input.createdBy,
    })
    .returning();
  return rows[0]!;
}

/**
 * Flip `pending` → `ready` conditionally. Returns the updated row when
 * the status transition was applied; returns null when the row is gone
 * OR already at `ready` — the service layer distinguishes those cases
 * via a follow-up read (404 vs 409 per AC-212).
 *
 * The WHERE predicate on `status = 'pending'` is the atomic guard that
 * turns the two-call flow (read → write) into a single CAS.
 */
export async function markReady(db: MutatingDatabase, id: string): Promise<AttachmentRow | null> {
  const rows = await db
    .update(attachments)
    .set({ status: 'ready' })
    .where(and(eq(attachments.id, id), eq(attachments.status, 'pending')))
    .returning();
  return rows[0] ?? null;
}

/**
 * Hard-delete by id. Returns the deleted row (for audit-payload capture)
 * or null when the row did not exist.
 */
export async function deleteById(db: MutatingDatabase, id: string): Promise<AttachmentRow | null> {
  const rows = await db.delete(attachments).where(eq(attachments.id, id)).returning();
  return rows[0] ?? null;
}

/**
 * List pending rows older than the cutoff time. Used by the orphan
 * reaper (data-model.md §6.11).
 */
export async function listOrphans(db: Database, cutoffTime: Date): Promise<AttachmentRow[]> {
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.status, 'pending'), lt(attachments.createdAt, cutoffTime)));
}

/**
 * Fetch attachments on a project regardless of status — used by the
 * bulk-download service to detect pending rows inside the batch
 * (AC-216 "any id referencing a row with status = 'pending' …").
 */
export async function listByIdsForProject(
  db: Database,
  projectId: string,
  ids: string[],
): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.projectId, projectId), inArray(attachments.id, ids)));
}

/**
 * Collect every attachment key (original + thumb) for a project. Used
 * by the purge cascade so the storage-side cleanup can fire after the
 * DB transaction commits (AC-218).
 */
export async function listKeysForProject(
  db: TransactionalDatabase,
  projectId: string,
): Promise<Array<{ originalKey: string; thumbKey: string | null }>> {
  return db
    .select({ originalKey: attachments.originalKey, thumbKey: attachments.thumbKey })
    .from(attachments)
    .where(eq(attachments.projectId, projectId));
}

/**
 * Delete pending rows older than cutoff directly. Returns the deleted
 * rows (for storage-side cleanup + count). The reaper is allowlisted in
 * `scripts/check-audit-mutations.sh` — rows never entered the domain,
 * so removal is housekeeping, not an audit event.
 */
export async function deleteOrphans(db: Database, cutoffTime: Date): Promise<AttachmentRow[]> {
  return db
    .delete(attachments)
    .where(and(eq(attachments.status, 'pending'), lt(attachments.createdAt, cutoffTime)))
    .returning();
}

export type { AttachmentStatus };
