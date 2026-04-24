/**
 * Attachment service — init / complete / delete / list / download-url /
 * bulk-download orchestration.
 *
 * The state machine is pinned by api.md §14.2.11 and data-model.md §5.13:
 *
 *   init        → row created at `status = 'pending'`; presigned POST(s)
 *                 issued for original (+thumb). Audit row (`attachment:add`)
 *                 via `mutate()`.
 *   complete    → HEAD verify both objects; flip to `status = 'ready'`.
 *                 No audit row (AC-219 — state-machine finalize).
 *   delete      → row hard-deleted; storage objects best-effort removed.
 *                 Audit row (`attachment:remove`) via `mutate()`.
 *
 * Worker scoping: the repository predicate narrows reads; the service
 * layer additionally rejects worker write/init on an unassigned project
 * (AC-214) and enforces the self-delete grace window (AC-215).
 */

import crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import type { ServiceLogger } from './Logger.js';
import type { Attachment, AttachmentLabel } from '../../domain/types.js';
import {
  ATTACHMENT_LABELS,
  ATTACHMENT_MIME_WHITELIST,
  classifyKind,
  isSafeFileName,
} from '../../domain/attachments.js';
import { type AttachmentStorageClient, StorageObjectNotFoundError } from '../storage/client.js';
import { isProjectInScope } from '../repositories/scope.js';
import {
  createPending,
  deleteById,
  getById,
  listByProject,
  markReady,
  type AttachmentRow,
  type AttachmentRowWithUploader,
} from '../repositories/attachment.js';
import { getProjectRowById } from '../repositories/project.js';
import { mutate } from './mutate.js';
import { conflict, notFound, notPermitted, validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { ATTACHMENT_CONFIG } from '../../config/attachmentConfig.js';
import { getEnv } from '../config/env.js';
import { BulkDownloadOrchestrator } from './BulkDownloadOrchestrator.js';

const FILE_NAME_MAX = 255;

const LABEL_VALUES = new Set<string>(ATTACHMENT_LABELS.map((entry) => entry.value));
const MIME_WHITELIST = new Set<string>(ATTACHMENT_MIME_WHITELIST);

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface InitUploadInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
}

export interface InitUploadResult {
  attachment: Attachment;
  originalUpload: PresignedPost;
  thumbnailUpload?: PresignedPost;
}

export interface DownloadUrlResult {
  url: string;
  expiresAt: string;
}

export type DownloadVariant = 'original' | 'thumbnail';

export interface AttachmentServiceDeps {
  db: Database;
  storage: AttachmentStorageClient;
}

interface ResolvedCaps {
  perFileCapBytes: number;
  bulkDownloadMaxFiles: number;
  bulkDownloadMaxBytes: number;
  workerSelfDeleteGraceMinutes: number;
}

function resolveCaps(): ResolvedCaps {
  // `validateEnv` has already run by the time a route handler reaches
  // the service; reading through `getEnv` keeps the config override
  // path consistent with the other `[C]` surfaces (auditRetention etc.).
  let env: ReturnType<typeof getEnv> | null = null;
  try {
    env = getEnv();
  } catch {
    // Tests that construct a service outside of startApp() fall through
    // to the build-time defaults. Production paths always call
    // `validateEnv()` before the first request.
    env = null;
  }
  return {
    perFileCapBytes: env?.ATTACHMENT_PER_FILE_CAP_BYTES ?? ATTACHMENT_CONFIG.perFileCapBytes,
    bulkDownloadMaxFiles: env?.ATTACHMENT_BULK_MAX_FILES ?? ATTACHMENT_CONFIG.bulkDownloadMaxFiles,
    bulkDownloadMaxBytes: env?.ATTACHMENT_BULK_MAX_BYTES ?? ATTACHMENT_CONFIG.bulkDownloadMaxBytes,
    workerSelfDeleteGraceMinutes:
      env?.ATTACHMENT_WORKER_SELF_DELETE_GRACE_MINUTES ??
      ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes,
  };
}

function isOwnerOrOffice(user: AuthUser): boolean {
  return user.roles.includes('owner') || user.roles.includes('office');
}

function callerIsWorkerOnly(user: AuthUser): boolean {
  // A caller is "worker-only" for delete-grace purposes when none of
  // the roles grants unscoped write (owner, office). Bookkeeper also
  // lacks `attachment:delete` entirely — the permission gate rejects
  // them before the service runs, so the grace logic doesn't fire for
  // bookkeepers.
  return !isOwnerOrOffice(user);
}

function toAttachment(row: AttachmentRowWithUploader): Attachment {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as Attachment['status'],
    kind: row.kind as Attachment['kind'],
    label: row.label as AttachmentLabel,
    fileName: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    originalKey: row.originalKey,
    thumbKey: row.thumbKey,
    hasThumbnail: row.hasThumbnail,
    createdAt: row.createdAt.toISOString(),
    createdBy:
      row.createdBy && row.uploaderDisplayName
        ? { id: row.createdBy, displayName: row.uploaderDisplayName }
        : null,
  };
}

function storageKey(projectId: string, attachmentId: string, suffix: 'orig' | 'thumb'): string {
  return `attachments/${projectId}/${attachmentId}.${suffix}`;
}

function attachmentAuditLabel(row: AttachmentRow): string {
  return row.filename;
}

export class AttachmentService {
  private readonly db: Database;
  private readonly storage: AttachmentStorageClient;
  private readonly bulkDownload: BulkDownloadOrchestrator;

  constructor(deps: AttachmentServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    // Bulk-download is a self-contained sub-flow (zip assembly +
    // temp-object upload + presigned GET). The orchestrator shares
    // `db` and `storage` but none of the state-machine helpers; caps
    // are resolved here and passed in per-call.
    this.bulkDownload = new BulkDownloadOrchestrator({ db: deps.db, storage: deps.storage });
  }

  /**
   * Init: validate inputs, ensure caller scope, write a pending row via
   * `mutate()`, issue presigned POST descriptors.
   */
  async initUpload(
    caller: AuthUser,
    projectId: string,
    input: InitUploadInput,
    log: ServiceLogger,
    correlationId: string | null,
  ): Promise<InitUploadResult> {
    // Project existence check — 404 takes precedence over scope (AC-214
    // + AC-147 pattern).
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (projectRow.deleted) throw notFound(STRINGS.entities.project);

    // Worker scope: reject the service call if the caller is scoped and
    // not assigned to the project. Route-level permission gate has
    // already accepted them.
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    // Input validation — each branch produces `422 VALIDATION_ERROR` and
    // persists no row (AC-211).
    const caps = resolveCaps();
    if (typeof input.fileName !== 'string' || input.fileName.length === 0) {
      throw validationError(STRINGS.validation.requiredString('fileName'));
    }
    if (input.fileName.length > FILE_NAME_MAX) {
      throw validationError(STRINGS.validation.maxLength('fileName', FILE_NAME_MAX));
    }
    // Reject control chars + path separators. Keeps header injection out
    // of the presigned-GET Content-Disposition (defence-in-depth; the
    // storage client ALSO sanitizes), and matches the spec's "sanitized
    // filename" intent by never letting a path-traversal-style name
    // reach the DB.
    if (!isSafeFileName(input.fileName)) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    if (!LABEL_VALUES.has(input.label)) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    if (!MIME_WHITELIST.has(input.mimeType)) {
      throw validationError(STRINGS.attachments.uploadMimeNotAllowed);
    }
    if (
      !Number.isInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > caps.perFileCapBytes
    ) {
      throw validationError(STRINGS.attachments.uploadFileTooLarge);
    }

    const kind = classifyKind(input.mimeType);
    // The client signals `hasThumbnail`. A photo without a thumbnail is
    // legal (no gallery render), but a binary with a thumbnail is not.
    const hasThumbnail = kind === 'photo' ? input.hasThumbnail : false;

    const attachmentId = crypto.randomUUID();
    const originalKey = storageKey(projectId, attachmentId, 'orig');
    const thumbKey = hasThumbnail ? storageKey(projectId, attachmentId, 'thumb') : null;

    const row = await mutate(
      this.db,
      { actorKind: 'user', actorId: caller.id, correlationId: correlationId ?? null },
      {
        entityType: 'attachment',
        action: 'attachment:add',
        run: async (tx) => {
          const inserted = await createPending(tx, {
            id: attachmentId,
            projectId,
            kind,
            label: input.label,
            filename: input.fileName,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            originalKey,
            thumbKey,
            hasThumbnail,
            createdBy: caller.id,
          });
          return {
            entityId: attachmentId,
            entityLabel: attachmentAuditLabel(inserted),
            value: inserted,
            before: {},
            after: {
              projectId,
              attachmentId,
              label: input.label,
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
            },
            // Nested entity: ancestor = project (architecture.md §11.12)
            // so the per-project activity feed picks this row up.
            ancestorEntityType: 'project',
            ancestorEntityId: projectId,
          };
        },
      },
    );

    log.info({ attachmentId: row.id, projectId }, 'attachment_init');

    // Main upload: pin content-length-range to the declared size exactly
    // so storage rejects any size-substitution attempt before the
    // complete() HEAD runs. Thumbnail upload: the true size is not
    // declared at init, so leave a [1, cap] range.
    const originalUpload = await this.storage.createPresignedPost(originalKey, input.mimeType, {
      minBytes: input.sizeBytes,
      maxBytes: input.sizeBytes,
    });
    const thumbnailUpload = thumbKey
      ? await this.storage.createPresignedPost(thumbKey, 'image/webp', {
          minBytes: 1,
          maxBytes: caps.perFileCapBytes,
        })
      : undefined;

    return {
      // Newly created row — uploader display name comes from the live
      // caller; saves a follow-up read since `createPending` returns the
      // base row and we already know who acted.
      attachment: toAttachment({ ...row, uploaderDisplayName: caller.displayName }),
      originalUpload,
      ...(thumbnailUpload ? { thumbnailUpload } : {}),
    };
  }

  /**
   * Complete: HEAD-check both objects, assert size-cap + content-type,
   * flip `pending` → `ready`. No audit row (AC-219).
   */
  async completeUpload(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    log: ServiceLogger,
  ): Promise<Attachment> {
    // Scope check early — spec requires worker on unassigned project to
    // receive 403 even when the attachment id does not exist (AC-214).
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    const row = await getById(this.db, attachmentId);
    if (!row || row.projectId !== projectId) {
      // Reaper already removed the row (or wrong-project mismatch). AC-212
      // pins 404 here so the client discards pending state.
      throw notFound(STRINGS.entities.resource);
    }
    if (row.status === 'ready') {
      // Idempotent one-way transition — double-ack returns 409.
      throw conflict(STRINGS.errors.invalidInput);
    }

    const caps = resolveCaps();
    // HEAD the original first.
    try {
      const head = await this.storage.headObject(row.originalKey);
      // Declared-size pin first (AC-212, spec §14.2.11 error paths).
      // The presigned POST's content-length-range already rejects this
      // at storage, so reaching this branch means a policy bypass —
      // refuse the flip so a size-substitution upload cannot become
      // canonical.
      if (head.size !== row.sizeBytes) {
        throw conflict(STRINGS.errors.invalidInput);
      }
      // Defence in depth: a global cap breach is still a conflict even
      // if the declared size matched (e.g., cap dropped since init).
      if (head.size > caps.perFileCapBytes) {
        throw conflict(STRINGS.errors.invalidInput);
      }
      if (head.contentType !== row.mimeType) {
        throw conflict(STRINGS.errors.invalidInput);
      }
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw conflict(STRINGS.errors.invalidInput);
      }
      throw err;
    }

    if (row.hasThumbnail && row.thumbKey) {
      try {
        // Defense in depth: the presigned POST policy already pins
        // size ≤ cap and content-type starts-with image/webp. Re-assert
        // at HEAD so a policy bypass that slipped past storage is still
        // caught at state-flip time.
        const thumbHead = await this.storage.headObject(row.thumbKey);
        if (thumbHead.size > caps.perFileCapBytes) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        if (!thumbHead.contentType.startsWith('image/')) {
          throw conflict(STRINGS.errors.invalidInput);
        }
      } catch (err) {
        if (err instanceof StorageObjectNotFoundError) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        throw err;
      }
    }

    // Flip pending → ready via a MutatingDatabase (no audit row, so we
    // use db.transaction directly — AC-219). A racing reaper between
    // the HEAD checks and this write surfaces as 404 on the next read,
    // which matches the client contract. The reaper may delete this
    // row during the HEAD→markReady gap; a storage object verified by
    // HEAD but not-yet-marked-ready can remain orphaned for up to one
    // reaper tick before the next sweep cleans it up.
    const updated = await this.db.transaction(async (tx) => markReady(tx, attachmentId));
    if (!updated) {
      // Either the row disappeared between the get + markReady calls
      // (reaper race — 404) or it's already ready (racing client — 409).
      const again = await getById(this.db, attachmentId);
      if (!again || again.projectId !== projectId) {
        throw notFound(STRINGS.entities.resource);
      }
      if (again.status === 'ready') {
        throw conflict(STRINGS.errors.invalidInput);
      }
      // Shouldn't reach here — but if it does, surface as conflict so
      // the client retries cleanly.
      throw conflict(STRINGS.errors.invalidInput);
    }

    log.info({ attachmentId, projectId }, 'attachment_ready');
    return toAttachment(updated);
  }

  /**
   * Delete: permission + scope + worker grace; hard-delete via mutate();
   * best-effort storage cleanup.
   */
  async deleteAttachment(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    log: ServiceLogger,
    correlationId: string | null,
  ): Promise<void> {
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    const row = await getById(this.db, attachmentId);
    if (!row || row.projectId !== projectId) {
      throw notFound(STRINGS.entities.resource);
    }

    // Worker self-delete grace (AC-215). Owner / office bypass.
    if (callerIsWorkerOnly(caller)) {
      if (row.createdBy !== caller.id) {
        throw notPermitted();
      }
      const caps = resolveCaps();
      const ageMinutes = (Date.now() - row.createdAt.getTime()) / 60_000;
      if (ageMinutes > caps.workerSelfDeleteGraceMinutes) {
        throw notPermitted();
      }
    }

    await mutate(
      this.db,
      { actorKind: 'user', actorId: caller.id, correlationId: correlationId ?? null },
      {
        entityType: 'attachment',
        action: 'attachment:remove',
        run: async (tx) => {
          const deleted = await deleteById(tx, attachmentId);
          return {
            entityId: attachmentId,
            entityLabel: deleted ? attachmentAuditLabel(deleted) : null,
            value: null,
            before: {
              projectId,
              attachmentId: row.id,
              label: row.label,
              mimeType: row.mimeType,
              sizeBytes: row.sizeBytes,
            },
            after: {},
            ancestorEntityType: 'project',
            ancestorEntityId: projectId,
          };
        },
      },
    );

    // Best-effort storage cleanup — a failure here does not resurrect
    // the row (the DB cascade already committed). Orphaned keys are
    // harmless; the reaper / bucket lifecycle ultimately cleans them.
    await this.bestEffortDelete(row.originalKey, log);
    if (row.thumbKey) {
      await this.bestEffortDelete(row.thumbKey, log);
    }

    log.info({ attachmentId, projectId }, 'attachment_removed');
  }

  async listForProject(caller: AuthUser, projectId: string): Promise<Attachment[]> {
    // 404 / 403 order mirrors the project-detail policy (AC-147) —
    // a missing project is 404, an existing project out-of-scope is 403.
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (projectRow.deleted) throw notFound(STRINGS.entities.project);
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }
    const rows = await listByProject(this.db, projectId, caller);
    return rows.map(toAttachment);
  }

  async issueDownloadUrl(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    variant: DownloadVariant,
  ): Promise<DownloadUrlResult> {
    if (variant !== 'original' && variant !== 'thumbnail') {
      throw validationError(STRINGS.errors.invalidInput);
    }

    const row = await getById(this.db, attachmentId);
    if (!row || row.projectId !== projectId) {
      throw notFound(STRINGS.entities.resource);
    }

    // Scope: worker hitting an attachment on an unassigned project is
    // 403 (AC-217 three-way result). The attachment row existence is
    // already confirmed above, so this branch cannot collapse to 404.
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    // Pending rows are invisible to consumers — matches `listByProject`
    // which only surfaces ready rows. Issuing a download URL for an
    // unverified upload would leak partially-uploaded bytes past the
    // HEAD-verify gate. 404 mirrors the reaper-removed branch.
    if (row.status !== 'ready') {
      throw notFound(STRINGS.entities.resource);
    }

    if (variant === 'thumbnail') {
      if (row.kind !== 'photo' || !row.thumbKey) {
        throw validationError(STRINGS.errors.invalidInput);
      }
      return this.storage.createPresignedGet(row.thumbKey);
    }
    // Originals download with attachment semantics so the browser honours
    // the row's fileName even on cross-origin storage hosts.
    return this.storage.createPresignedGet(row.originalKey, undefined, row.filename);
  }

  /**
   * Entry point for the bulk-download flow. Resolves caps and delegates
   * to `BulkDownloadOrchestrator` — see that module for the zip-assembly
   * contract, entry-naming policy and cleanup model (api.md §14.2.11,
   * AC-216, AC-221).
   */
  async issueBulkDownloadUrl(
    caller: AuthUser,
    projectId: string,
    attachmentIds: string[],
  ): Promise<DownloadUrlResult> {
    const caps = resolveCaps();
    return this.bulkDownload.issueBulkDownloadUrl(caller, projectId, attachmentIds, {
      bulkDownloadMaxFiles: caps.bulkDownloadMaxFiles,
      bulkDownloadMaxBytes: caps.bulkDownloadMaxBytes,
    });
  }

  /**
   * Best-effort storage delete. Swallows errors so a transient storage
   * outage does not surface as a 500 after the DB commit succeeds. The
   * operational log preserves the orphaned key so cleanup can follow.
   */
  private async bestEffortDelete(key: string, log: ServiceLogger): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (err) {
      log.error(
        {
          event: 'attachment_storage_delete_failed',
          key,
          // `error_hint` matches the orphan-reaper / bulk-download-reaper
          // contract (AC-213, data-model.md §6.11) so a single log-field
          // name works across every attachment storage-cleanup path.
          error_hint: err instanceof Error ? err.message : String(err),
        },
        'attachment_storage_delete_failed',
      );
    }
  }
}

/**
 * Exported for the purge-cascade path in `ProjectCrudService` — the
 * cascade collects keys pre-commit via `listKeysForProject` and then
 * calls this helper after the DB transaction returns.
 */
export async function bestEffortDeleteStorageKeys(
  storage: AttachmentStorageClient,
  keys: Array<{ originalKey: string; thumbKey: string | null }>,
  log: ServiceLogger,
): Promise<void> {
  for (const entry of keys) {
    try {
      await storage.deleteObject(entry.originalKey);
    } catch (err) {
      log.error(
        {
          event: 'attachment_storage_delete_failed',
          key: entry.originalKey,
          error_hint: err instanceof Error ? err.message : String(err),
        },
        'attachment_storage_delete_failed',
      );
    }
    if (entry.thumbKey) {
      try {
        await storage.deleteObject(entry.thumbKey);
      } catch (err) {
        log.error(
          {
            event: 'attachment_storage_delete_failed',
            key: entry.thumbKey,
            error_hint: err instanceof Error ? err.message : String(err),
          },
          'attachment_storage_delete_failed',
        );
      }
    }
  }
}
