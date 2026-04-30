/**
 * Attachment service — init / complete / hide / restore / list /
 * Papierkorb listing / download-url / bulk-download orchestration.
 *
 * The state machine is pinned by api.md §14.2.11, data-model.md §5.13
 * and ADR-0022 (capability split + Papierkorb):
 *
 *   init        → row created at `status = 'pending'`; presigned PUT(s)
 *                 issued for original (+thumb), pinning Content-Type,
 *                 Content-Length, and Content-MD5 via SigV4. Audit row
 *                 (`attachment:add`) via `mutate()`.
 *   complete    → HEAD verify both objects; flip to `status = 'ready'`
 *                 and persist the per-version-id pair (ADR-0022).
 *                 No audit row (AC-219 — state-machine finalize).
 *   hide        → `DeleteObject` (no versionId) on each storage key
 *                 writes a delete marker on the versioned bucket;
 *                 the prior version stays intact for restore. Then
 *                 the CAS `ready` → `hidden` and the audit row commit
 *                 atomically inside `mutate()`. Storage runs FIRST so
 *                 a transient storage outage surfaces as 5xx (the
 *                 user retries) instead of leaving a `hidden` row
 *                 paired with a still-current storage object that
 *                 lifecycle would never reap.
 *   restore     → flip `hidden` → `ready` via CAS, then
 *                 `copyFromVersion` to promote the persisted version
 *                 back to current, then write the freshly-issued
 *                 version-ids. All inside one `mutate()` tx — the
 *                 storage advance is reachable only after the CAS
 *                 commits, so two concurrent restores cannot both
 *                 advance storage. Audit row (`attachment:restore`).
 *
 * Worker scoping: the repository predicate narrows reads; the service
 * layer additionally rejects worker write/init on an unassigned project
 * (AC-214) and enforces the self-delete grace window (AC-215).
 *
 * Archive interaction: hide is gated on the project NOT being archived
 * (read-only preview); restore is permitted on archived projects so
 * binaries in an archived project's trash are not silently reaped by
 * lifecycle.
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
import {
  type AttachmentStorageClient,
  type PresignedPutDescriptor,
  StorageObjectNotFoundError,
} from '../storage/client.js';
import { isProjectInScope } from '../repositories/scope.js';
import {
  createPending,
  markHidden,
  markRestored,
  setVersionIds,
  getById,
  listByProject,
  listHiddenByProject,
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

/**
 * Wire shape returned by `POST /api/projects/:id/attachments/init` for
 * each upload (original + optional thumbnail). Identical to the storage
 * client's `PresignedPutDescriptor` — re-exported under a verb-neutral
 * name so the API contract reads naturally.
 */
export type PresignedUpload = PresignedPutDescriptor;

export interface InitUploadInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** RFC 1864 base64 of the original blob's MD5 (24 chars, ends `==`). */
  contentMd5: string;
  label: AttachmentLabel;
  hasThumbnail: boolean;
  /**
   * Required when `hasThumbnail = true`. The client computes the
   * thumbnail before init so the server can sign a tight, exact-size
   * PUT (parity with the original-upload pin) instead of a liberal
   * `[1, perFileCap]` range that the POST policy used to express.
   */
  thumbSizeBytes?: number;
  /** Required when `hasThumbnail = true`. RFC 1864 base64 MD5. */
  thumbContentMd5?: string;
}

export interface InitUploadResult {
  attachment: Attachment;
  originalUpload: PresignedUpload;
  thumbnailUpload?: PresignedUpload;
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
  perThumbCapBytes: number;
  bulkDownloadMaxFiles: number;
  bulkDownloadMaxBytes: number;
  workerSelfDeleteGraceMinutes: number;
}

function resolveCaps(): ResolvedCaps {
  // `validateEnvRuntime` has already run by the time a route handler reaches
  // the service; reading through `getEnv` keeps the config override
  // path consistent with the other `[C]` surfaces (auditRetention etc.).
  let env: ReturnType<typeof getEnv> | null = null;
  try {
    env = getEnv();
  } catch {
    // Tests that construct a service outside of startApp() fall through
    // to the build-time defaults. Production paths always call
    // `validateEnvRuntime()` before the first request.
    env = null;
  }
  return {
    perFileCapBytes: env?.ATTACHMENT_PER_FILE_CAP_BYTES ?? ATTACHMENT_CONFIG.perFileCapBytes,
    perThumbCapBytes: env?.ATTACHMENT_THUMB_CAP_BYTES ?? ATTACHMENT_CONFIG.perThumbCapBytes,
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
  // lacks `attachment:hide` entirely — the permission gate rejects
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
    hiddenAt: row.hiddenAt ? row.hiddenAt.toISOString() : null,
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

/**
 * RFC 1864 base64 of an MD5 digest is exactly 24 chars: 21 of
 * [A-Za-z0-9+/], one of [AQgw] at position 22 (only those four
 * carry zero-bit alignment for a 16-byte digest), then `==`. The
 * tighter alphabet at position 22 rejects malformed values that the
 * coarser `[A-Za-z0-9+/]{22}==` would accept. Used both at the
 * service-layer for `contentMd5` and via the route schema's pattern.
 */
const MD5_BASE64_RE = /^[A-Za-z0-9+/]{21}[AQgw]==$/;

function isMd5Base64(value: unknown): value is string {
  return typeof value === 'string' && MD5_BASE64_RE.test(value);
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
   * `mutate()`, issue presigned PUT descriptors (one per blob).
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
    // persists no row (AC-245).
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
    // RFC 1864 base64 of 16-byte MD5 → 24 chars, last two `==`. Reject
    // anything else here so the storage signer cannot be handed a
    // malformed value. The storage provider's `BadDigest` check is the
    // next layer.
    if (!isMd5Base64(input.contentMd5)) {
      throw validationError(STRINGS.errors.invalidInput);
    }

    const kind = classifyKind(input.mimeType);
    // The client signals `hasThumbnail`. A photo without a thumbnail is
    // legal (no gallery render), but a binary with a thumbnail is not.
    const hasThumbnail = kind === 'photo' ? input.hasThumbnail : false;

    // Thumbnail size + MD5 are required when a thumbnail is being
    // signed. The client must run the image pipeline to know the
    // thumbnail blob's exact bytes before calling init — that gives us
    // the same exact-size pin on the thumbnail upload that we already
    // have on the original. The cap is `perThumbCapBytes`, NOT the
    // per-file cap: the thumbnail is server-encoded WebP at 320 px /
    // q=0.72 (`attachmentPipeline.ts`) — sized in the tens of KB.
    // Allowing a 1 MB "thumbnail" through would be a policy bypass.
    let thumbSizeBytes: number | undefined;
    let thumbContentMd5: string | undefined;
    if (hasThumbnail) {
      if (
        typeof input.thumbSizeBytes !== 'number' ||
        !Number.isInteger(input.thumbSizeBytes) ||
        input.thumbSizeBytes <= 0 ||
        input.thumbSizeBytes > caps.perThumbCapBytes
      ) {
        throw validationError(STRINGS.attachments.uploadFileTooLarge);
      }
      if (!isMd5Base64(input.thumbContentMd5)) {
        throw validationError(STRINGS.errors.invalidInput);
      }
      thumbSizeBytes = input.thumbSizeBytes;
      thumbContentMd5 = input.thumbContentMd5;
    }

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
            thumbSizeBytes: thumbSizeBytes ?? null,
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

    // Sign one presigned PUT per blob. Each binds Content-Type +
    // Content-Length + Content-MD5 (see `createPresignedPut`); a client
    // that mutates any of the three fails signature verification. The
    // body MD5 is verified against received bytes by the storage
    // provider (`BadDigest`), so the URL is reusable only for the exact
    // bytes the client committed to at init time.
    const originalUpload = await this.storage.createPresignedPut(
      originalKey,
      input.mimeType,
      input.sizeBytes,
      input.contentMd5,
    );
    const thumbnailUpload =
      thumbKey && thumbSizeBytes !== undefined && thumbContentMd5 !== undefined
        ? await this.storage.createPresignedPut(
            thumbKey,
            'image/webp',
            thumbSizeBytes,
            thumbContentMd5,
          )
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

    // Race guard: a project archived between init and complete must not
    // produce a `ready` row. initUpload blocks archived rows up front,
    // but the storage round-trip leaves a window where archive can land
    // before the flip. The pending row stays for the reaper.
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow || projectRow.deleted) {
      throw notFound(STRINGS.entities.project);
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
    // HEAD the original first. Capture VersionId for the restore path
    // (ADR-0022) — the bucket is versioned, every PUT produces a fresh
    // version-id, and the version that is current immediately post-
    // upload is exactly what `copyFromVersion` must recreate later.
    let versionId: string | null;
    try {
      const head = await this.storage.headObject(row.originalKey);
      // Declared-size pin first (AC-212, spec §14.2.11 error paths).
      // The presigned PUT's signed `Content-Length` already rejects a
      // size deviation at the signature layer, so reaching this branch
      // means a signature bypass — refuse the flip so a size-substituted
      // upload cannot become canonical.
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
      versionId = head.versionId ?? null;
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw conflict(STRINGS.errors.invalidInput);
      }
      throw err;
    }

    let thumbVersionId: string | null = null;
    if (row.hasThumbnail && row.thumbKey) {
      try {
        // Defense in depth: the presigned PUT already pins
        // Content-Length to the exact thumb size and Content-Type to
        // image/webp via SigV4. Re-assert at HEAD so a signature bypass
        // that slipped past storage is still caught at state-flip time.
        const thumbHead = await this.storage.headObject(row.thumbKey);
        // Declared-size pin first — mirrors the original-side check
        // above. The persisted `thumb_size_bytes` is the value the
        // client committed to at init; a HEAD reporting a different
        // size means a signature bypass landed bytes the row never
        // accepted. Only assert when the row carries a value: legacy
        // pending rows that predate the column have null and fall
        // through to the cap-only check.
        if (row.thumbSizeBytes !== null && thumbHead.size !== row.thumbSizeBytes) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        if (thumbHead.size > caps.perThumbCapBytes) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        if (!thumbHead.contentType.startsWith('image/')) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        thumbVersionId = thumbHead.versionId ?? null;
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
    const updated = await this.db.transaction(async (tx) =>
      markReady(tx, attachmentId, { versionId, thumbVersionId }),
    );
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
   * Hide (user-initiated DELETE; soft-hide per ADR-0022). Validates
   * caller scope, the project's read-write status (archive gate), and
   * the worker self-delete grace window (AC-215).
   *
   * Storage-first ordering, outside the DB transaction. The
   * `DeleteObject` (no versionId) writes a delete marker on the
   * versioned bucket; the prior version is preserved so restore can
   * promote it back. A storage failure throws and propagates as 5xx
   * — no DB change happens, the user retries from scratch. Storage
   * hide is idempotent: repeating against an already-hidden key just
   * appends another delete marker, lifecycle reaps both. Running
   * storage AHEAD of `mutate()` keeps the bucket lifecycle's
   * NONCURRENT-only reap consistent with the row's `hidden` status:
   * the alternative (DB CAS first, swallow storage faults) leaks the
   * underlying object as the "current" version forever, with no UI
   * affordance to retry. After storage succeeds, the CAS flip
   * (`ready` → `hidden`) and the audit row commit atomically inside
   * `mutate()`.
   */
  async hideAttachment(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    log: ServiceLogger,
    correlationId: string | null,
  ): Promise<void> {
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    // Archived projects are read-only previews — server-side defence
    // matching the project-mutation gate (AC-95). The detail-page UI
    // already hides the trash affordance, but a direct API call must
    // not slip through. 404 mirrors the project-mutation contract: the
    // attachment "is gone" from the perspective of editable surfaces.
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow || projectRow.deleted) {
      throw notFound(STRINGS.entities.project);
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

    // Storage hide BEFORE the DB CAS. A throw here surfaces as 5xx
    // and leaves the row in `ready`; the user retries. Doing this
    // inside `mutate()`'s `run` would couple a non-transactional side
    // effect to the SQL tx — a later rollback (e.g. the CAS losing
    // its predicate to a racing hide) cannot undo a successful
    // `DeleteObject`, producing the symmetric orphan in the opposite
    // direction.
    await this.storage.hide(row.originalKey);
    if (row.thumbKey) {
      await this.storage.hide(row.thumbKey);
    }

    await mutate(
      this.db,
      { actorKind: 'user', actorId: caller.id, correlationId: correlationId ?? null },
      {
        entityType: 'attachment',
        action: 'attachment:hide',
        run: async (tx) => {
          const hidden = await markHidden(tx, attachmentId);
          if (!hidden) {
            // Lost the CAS — the row was not in `ready` at the moment of
            // the UPDATE. Either it was already hidden (double-click,
            // racing client), or never reached ready (stuck pending),
            // or was reaped between the read and write. 409 in all
            // cases — the client refetches and sees the actual state.
            // The storage delete marker we just wrote is harmless
            // (idempotent) and aligns with the racing hide that
            // already won the CAS.
            throw conflict(STRINGS.errors.invalidInput);
          }
          return {
            entityId: attachmentId,
            entityLabel: attachmentAuditLabel(hidden),
            value: null,
            before: {
              projectId,
              attachmentId: row.id,
              label: row.label,
              mimeType: row.mimeType,
              sizeBytes: row.sizeBytes,
            },
            after: {
              hiddenAt: hidden.hiddenAt?.toISOString() ?? null,
            },
            ancestorEntityType: 'project',
            ancestorEntityId: projectId,
          };
        },
      },
    );

    log.info({ attachmentId, projectId }, 'attachment_hidden');
  }

  async listForProject(caller: AuthUser, projectId: string): Promise<Attachment[]> {
    // 404 / 403 order mirrors the project-detail policy (AC-147) —
    // a missing project is 404, an existing project out-of-scope is 403.
    // Archived projects ARE listed: the detail page renders them as a
    // read-only preview (api.md §14.2.2), so the attachment listing has
    // to surface alongside the rest of the body. Mutation paths
    // (initUpload, hideAttachment) keep the archived gate.
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }
    const rows = await listByProject(this.db, projectId, caller);
    return rows.map(toAttachment);
  }

  /**
   * Papierkorb listing — hidden rows on the project, newest hide first.
   * Route gate (`attachment:trash`) restricts to owner / office; this
   * method assumes the gate has run and only enforces project scope.
   */
  async listHiddenForProject(caller: AuthUser, projectId: string): Promise<Attachment[]> {
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }
    const rows = await listHiddenByProject(this.db, projectId, caller);
    return rows.map(toAttachment);
  }

  /**
   * Restore: flip `hidden` → `ready` via CAS, then `copyFromVersion`
   * from the persisted version-id pair, then write the freshly-issued
   * current-version ids. The whole sequence runs inside `mutate()` so
   * the audit chain records the restore atomically with the storage
   * advance — a CAS-loss aborts before any storage call (no orphan
   * current versions); a storage failure rolls back the status flip
   * and the audit row (the user retries cleanly).
   *
   * Atomicity choice: copies run AFTER the CAS, inside the surrounding
   * transaction. The trade-off is that a transient storage fault rolls
   * the audit row back too; the user repeats the call. The alternative
   * (copy first, compensate on CAS-loss) was rejected because the
   * compensation can itself fail.
   *
   * Asymmetry with hide (intentional): restore is permitted on archived
   * projects; hide is not. Archive is a reversible state (re-activate
   * is a design feature elsewhere); destruction-by-lifecycle is not.
   * If restore were forbidden during archival, binaries in an archived
   * project's trash would silently reap after L days with no recovery
   * path. Hide on an archived project stays forbidden — read-only
   * previews must not accept new mutations.
   *
   * Failure modes (each maps to a distinct status-code surface):
   *   - Row not in 'hidden' state → 409 (transient: client refetches
   *     and sees the actual state).
   *   - Row missing or wrong project → 404 (project itself missing
   *     also surfaces as 404).
   *   - Storage CopyObject failure → 500 (genuine provider fault; the
   *     transaction rolls back, the row stays hidden, the user can
   *     retry).
   *   - `versionId` is null on a 'hidden' row → 422
   *     (Datenintegritätsproblem — restore is structurally impossible).
   *   - `hasThumbnail=true` with `thumb_version_id` null → 422
   *     (gallery preview would be permanently lost; surface the
   *     integrity violation rather than silently restore a broken
   *     row).
   *   - CAS-loss inside the tx → 409 (transient race).
   */
  async restoreAttachment(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    log: ServiceLogger,
    correlationId: string | null,
  ): Promise<Attachment> {
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }
    // Existence check, but NOT an archive gate — restore is the
    // un-loss move, permitted on archived projects so binaries in the
    // trash are not silently reaped by lifecycle. Hide-side keeps the
    // archive gate (read-only previews refuse new mutations).
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) {
      throw notFound(STRINGS.entities.project);
    }
    const row = await getById(this.db, attachmentId);
    if (!row || row.projectId !== projectId) {
      throw notFound(STRINGS.entities.resource);
    }
    if (row.status !== 'hidden') {
      throw conflict(STRINGS.errors.invalidInput);
    }
    if (!row.versionId) {
      // No source version → restore is structurally impossible. Every
      // hide records the version_id at complete-time; a 'hidden' row
      // without one is a data-integrity issue. 422 (not 409) — 409
      // implies "retry" and the row will not become restorable on its
      // own.
      throw validationError(STRINGS.attachments.restoreMissingVersionId(attachmentId));
    }
    if (row.hasThumbnail && row.thumbKey && !row.thumbVersionId) {
      // The gallery thumb is part of the photo's restorable state.
      // Silently skipping the thumb copy would permanently lose the
      // gallery preview without any error signal — surface the integrity
      // violation as 422 so the operator can inspect.
      throw validationError(STRINGS.attachments.restoreMissingThumbVersionId(attachmentId));
    }

    // Snapshot the source version-ids — the inside-tx copies run from
    // these. After the CAS commits we know nobody else can race the
    // same row (the row-level lock on the UPDATE blocks concurrent CAS
    // attempts until this tx ends).
    const sourceVersionId = row.versionId;
    const sourceThumbVersionId = row.thumbKey ? row.thumbVersionId : null;

    const restored = await mutate(
      this.db,
      { actorKind: 'user', actorId: caller.id, correlationId: correlationId ?? null },
      {
        entityType: 'attachment',
        action: 'attachment:restore',
        run: async (tx) => {
          // Phase 1 — CAS the status. Holding the row lock from here
          // means no concurrent restorer can advance storage while we
          // copy below.
          const flipped = await markRestored(tx, attachmentId);
          if (!flipped) {
            // CAS lost — racing restore committed first, or the row
            // shifted out of 'hidden' between our read and this write.
            // No storage call has happened yet, so there is nothing to
            // compensate. The user retries.
            throw conflict(STRINGS.errors.invalidInput);
          }

          // Phase 2 — copy. A failure here throws out of the tx and
          // rolls back Phase 1 (status returns to 'hidden') AND the
          // audit row. The bucket retains only the prior hidden version.
          const newVersionId =
            (await this.storage.copyFromVersion(row.originalKey, sourceVersionId)) ?? null;
          let newThumbVersionId: string | null = null;
          if (row.thumbKey && sourceThumbVersionId) {
            newThumbVersionId =
              (await this.storage.copyFromVersion(row.thumbKey, sourceThumbVersionId)) ?? null;
          }

          // Phase 3 — write the freshly-issued version-ids. We hold the
          // row lock from Phase 1, so this is a plain UPDATE with no
          // CAS predicate; setVersionIds returns null only if the id
          // does not exist (would be a programmer error here).
          const updated = await setVersionIds(tx, attachmentId, {
            versionId: newVersionId,
            thumbVersionId: newThumbVersionId,
          });
          if (!updated) {
            throw new Error('restoreAttachment: row vanished mid-transaction');
          }

          return {
            entityId: attachmentId,
            entityLabel: attachmentAuditLabel(updated),
            value: updated,
            before: {
              hiddenAt: row.hiddenAt?.toISOString() ?? null,
              versionId: sourceVersionId,
              thumbVersionId: sourceThumbVersionId,
            },
            after: {
              versionId: newVersionId,
              thumbVersionId: newThumbVersionId,
            },
            ancestorEntityType: 'project',
            ancestorEntityId: projectId,
          };
        },
      },
    );

    log.info({ attachmentId, projectId }, 'attachment_restored');
    return toAttachment(restored);
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
}

/**
 * Exported for the purge-cascade path in `ProjectCrudService` — the
 * cascade collects keys pre-commit via `listKeysForProject` and then
 * calls this helper after the DB transaction returns.
 */
export async function bestEffortHideStorageKeys(
  storage: AttachmentStorageClient,
  keys: Array<{ originalKey: string; thumbKey: string | null }>,
  log: ServiceLogger,
): Promise<void> {
  for (const entry of keys) {
    try {
      await storage.hide(entry.originalKey);
    } catch (err) {
      log.error(
        {
          event: 'attachment_storage_hide_failed',
          key: entry.originalKey,
          error_hint: err instanceof Error ? err.message : String(err),
        },
        'attachment_storage_hide_failed',
      );
    }
    if (entry.thumbKey) {
      try {
        await storage.hide(entry.thumbKey);
      } catch (err) {
        log.error(
          {
            event: 'attachment_storage_hide_failed',
            key: entry.thumbKey,
            error_hint: err instanceof Error ? err.message : String(err),
          },
          'attachment_storage_hide_failed',
        );
      }
    }
  }
}
