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
import { attachments, users } from '../db/schema.js';
import type { AttachmentKind, AttachmentLabel, AttachmentStatus } from '../../domain/types.js';
import type { AuthUser } from '../middleware/auth.js';
import { attachmentScopeForCaller } from './scope.js';

export type AttachmentRow = typeof attachments.$inferSelect;

/**
 * Read-side row shape: the attachment columns plus the uploader's display
 * name resolved via FK. `uploaderDisplayName` is null when the uploader
 * row is absent (FK was set null on user delete) or when the attachment
 * has no uploader (system-created — none today, but the column nullability
 * is preserved). Service layer reshapes this into the wire `Attachment`.
 */
export type AttachmentRowWithUploader = AttachmentRow & {
  uploaderDisplayName: string | null;
};

/**
 * Drizzle's leftJoin returns a nested `{ attachments: ..., users: ... }`
 * shape; flatten it into the read-row contract before returning so
 * downstream code stays unaware of the join.
 */
function flattenWithUploader(row: {
  attachments: AttachmentRow;
  users: { displayName: string } | null;
}): AttachmentRowWithUploader {
  return { ...row.attachments, uploaderDisplayName: row.users?.displayName ?? null };
}

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
): Promise<AttachmentRowWithUploader[]> {
  const scope = attachmentScopeForCaller(caller);
  const conditions = [eq(attachments.projectId, projectId), eq(attachments.status, 'ready')];
  if (scope) conditions.push(scope);
  const rows = await db
    .select({ attachments, users: { displayName: users.displayName } })
    .from(attachments)
    .leftJoin(users, eq(attachments.createdBy, users.id))
    .where(and(...conditions))
    .orderBy(desc(attachments.createdAt), desc(attachments.id));
  return rows.map(flattenWithUploader);
}

/**
 * Get a single attachment by id WITHOUT the scope predicate. Used by
 * the service layer's get-by-id which decides `404 / 403 / 200` with a
 * distinct scope lookup (parallel to `getProject` in `project-read.ts`).
 */
export async function getById(
  db: TransactionalDatabase,
  id: string,
): Promise<AttachmentRowWithUploader | null> {
  const rows = await db
    .select({ attachments, users: { displayName: users.displayName } })
    .from(attachments)
    .leftJoin(users, eq(attachments.createdBy, users.id))
    .where(eq(attachments.id, id))
    .limit(1);
  const row = rows[0];
  return row ? flattenWithUploader(row) : null;
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
 * Flip `pending` → `ready` conditionally and persist the per-version-id
 * pair captured at HEAD-verify time (ADR-0022). Returns the updated row
 * when the status transition was applied; returns null when the row is
 * gone OR already at `ready` — the service layer distinguishes those
 * cases via a follow-up read (404 vs 409 per AC-212).
 *
 * The WHERE predicate on `status = 'pending'` is the atomic guard that
 * turns the two-call flow (read → write) into a single CAS.
 *
 * `thumbVersionId` is set in tandem with `versionId` for photos
 * (`hasThumbnail=true`); for binaries it is null, mirroring `thumbKey`.
 * Both are captured from the bucket's HEAD response — the version that
 * is current immediately post-upload is what restore must recreate.
 */
export async function markReady(
  db: MutatingDatabase,
  id: string,
  versions: { versionId: string | null; thumbVersionId: string | null },
): Promise<AttachmentRowWithUploader | null> {
  const rows = await db
    .update(attachments)
    .set({
      status: 'ready',
      versionId: versions.versionId,
      thumbVersionId: versions.thumbVersionId,
    })
    .where(and(eq(attachments.id, id), eq(attachments.status, 'pending')))
    .returning();
  if (!rows[0]) return null;
  // Re-read inside the same tx to pick up the uploader display name via
  // the JOIN; UPDATE...RETURNING cannot select joined columns directly.
  return getById(db, id);
}

/**
 * Hard-delete by id. Returns the deleted row (for audit-payload capture)
 * or null when the row did not exist.
 *
 * Used by the orphan reaper (pending rows that never reached the audit
 * chain) and by the project-delete cascade (the project row's audit
 * carries the destruction; per-attachment audit rows would duplicate
 * that). User-initiated removals go through `markHidden` instead —
 * those are reversible and need their own audit row.
 */
export async function deleteById(db: MutatingDatabase, id: string): Promise<AttachmentRow | null> {
  const rows = await db.delete(attachments).where(eq(attachments.id, id)).returning();
  return rows[0] ?? null;
}

/**
 * Flip `ready` → `hidden`, stamp `hidden_at = now()`. Returns the updated
 * row when the transition was applied; null when the row is gone or
 * already in another state. Atomic CAS via the WHERE on `status='ready'`.
 *
 * Pending rows can never reach hidden — they are reaped by the orphan
 * reaper (their backing upload never completed; there is nothing to
 * restore). Hidden rows are idempotent at the API level — a second
 * DELETE returns 409 because this returns null.
 */
export async function markHidden(
  db: MutatingDatabase,
  id: string,
): Promise<AttachmentRowWithUploader | null> {
  const rows = await db
    .update(attachments)
    .set({ status: 'hidden', hiddenAt: new Date() })
    .where(and(eq(attachments.id, id), eq(attachments.status, 'ready')))
    .returning();
  if (!rows[0]) return null;
  return getById(db, id);
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
 *
 * The caller's scope predicate is ANDed into the query per ADR-0019,
 * so a scoped caller hitting ids on an unassigned project gets an
 * empty result set at the repo layer. The service layer's
 * `isProjectInScope` precondition still runs first — defence in depth.
 */
export async function listByIdsForProject(
  db: Database,
  projectId: string,
  ids: string[],
  caller: AuthUser,
): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  const scope = attachmentScopeForCaller(caller);
  const conditions = [eq(attachments.projectId, projectId), inArray(attachments.id, ids)];
  if (scope) conditions.push(scope);
  return db
    .select()
    .from(attachments)
    .where(and(...conditions));
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
