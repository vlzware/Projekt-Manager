/**
 * Bulk-download orchestrator — assembles a zip of requested attachments,
 * uploads it to the `bulk-downloads/` prefix, and returns a presigned
 * GET URL pointing at that temp object. See api.md §14.2.11, AC-216,
 * AC-221.
 *
 * Extracted from `AttachmentService` to keep the latter focused on the
 * init / complete / delete / list / download-url state machine. The
 * public entry point stays reachable through
 * `AttachmentService.issueBulkDownloadUrl`, which delegates here — route
 * handlers are unaware of the split.
 *
 * Byte flow: storage → archiver → buffer → storage → (client via
 * presigned URL). Bytes never flow through the client's HTTP socket to
 * the app; the presigned URL is what the client hits to download.
 *
 * Cleanup: the temp zip is NOT tracked in the DB. A sibling reaper
 * (`bulk-download-reaper.ts`) sweeps the `bulk-downloads/` prefix by
 * `LastModified` age. This keeps the orchestrator simple — read ops are
 * unaudited (ADR-0021) and the spec already forbids a DB row for a
 * transient export artifact.
 */

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import archiver from 'archiver';
import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { isProjectInScope } from '../repositories/scope.js';
import { listByIdsForProject, type AttachmentRow } from '../repositories/attachment.js';
import { getProjectRowById } from '../repositories/project.js';
import { bulkLimitExceeded, notFound, notPermitted, validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';

/**
 * Storage prefix under which every bulk-download zip lives. Kept
 * separate from `attachments/<projectId>/…` so:
 *   - the orphan reaper's `attachments/` scope cannot accidentally
 *     reach bulk-download temp zips;
 *   - a dedicated sibling sweep (see `bulk-download-reaper.ts`) can
 *     `listObjects(BULK_DOWNLOAD_PREFIX, olderThan)` and delete by age
 *     without touching a single live attachment object.
 *
 * Exported because the dedicated reaper lives in a separate module and
 * needs the same constant — a shared literal would drift otherwise.
 */
export const BULK_DOWNLOAD_PREFIX = 'bulk-downloads/';

export interface BulkDownloadCaps {
  bulkDownloadMaxFiles: number;
  bulkDownloadMaxBytes: number;
}

export interface BulkDownloadUrlResult {
  url: string;
  expiresAt: string;
}

export interface BulkDownloadOrchestratorDeps {
  db: Database;
  storage: AttachmentStorageClient;
}

/**
 * Pick a zip-entry name for `row` that has not yet appeared in `used`.
 * On first occurrence, use `row.filename` as-is. On subsequent
 * occurrences, insert ` (<shortId>)` before the extension — e.g.
 * `rechnung.pdf` → `rechnung (a1b2c3d4).pdf`. The short id is the
 * first 8 chars of the attachment UUID, which is unique per row, so
 * two rows with the same filename always get distinct names and a
 * third collision (same filename AND a UUID prefix collision — 1 in
 * 2^32 per pair) would still be caught by the `used.has(candidate)`
 * fallback that appends the full id.
 *
 * Mutates `used` — consumer is responsible for passing a fresh Set
 * per zip assembly.
 */
function disambiguateName(row: AttachmentRow, used: Set<string>): string {
  const original = row.filename;
  if (!used.has(original)) {
    used.add(original);
    return original;
  }
  const shortId = row.id.replace(/-/g, '').slice(0, 8);
  const dot = original.lastIndexOf('.');
  const base = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : '';
  let candidate = `${base} (${shortId})${ext}`;
  if (used.has(candidate)) {
    // Paranoia fallback — see jsdoc; falls back to the full id when
    // the 8-char prefix collides within the same zip.
    candidate = `${base} (${row.id})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

export class BulkDownloadOrchestrator {
  private readonly db: Database;
  private readonly storage: AttachmentStorageClient;

  constructor(deps: BulkDownloadOrchestratorDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
  }

  /**
   * Assemble a zip of the requested attachments, upload it to a scoped
   * `bulk-downloads/` prefix, and return a presigned GET URL pointing at
   * that temp object.
   *
   * Entry-naming: each zip entry is named after the row's `fileName`.
   * When the same `fileName` appears twice in one batch, subsequent
   * copies receive a ` (<shortId>)` suffix before the extension so
   * zip viewers do not silently collide (Windows Explorer in particular
   * refuses to open two entries with the same name).
   *
   * Caps are injected by the caller so the orchestrator stays ignorant
   * of the env / build-time resolver — the owning service resolves once
   * and passes the struct in.
   */
  async issueBulkDownloadUrl(
    caller: AuthUser,
    projectId: string,
    attachmentIds: string[],
    caps: BulkDownloadCaps,
  ): Promise<BulkDownloadUrlResult> {
    if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
      throw validationError(STRINGS.errors.invalidInput);
    }

    // Count cap fires FIRST — AC-216 pins "exceeding either cap is
    // rejected"; failing fast on count keeps a flood of fake ids from
    // triggering a DB round-trip.
    if (attachmentIds.length > caps.bulkDownloadMaxFiles) {
      throw bulkLimitExceeded({
        limits: {
          maxFiles: caps.bulkDownloadMaxFiles,
          maxBytes: caps.bulkDownloadMaxBytes,
        },
      });
    }

    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    const rows = await listByIdsForProject(this.db, projectId, attachmentIds, caller);
    // Every requested id must exist on this project.
    if (rows.length !== attachmentIds.length) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    // No pending rows in batch (AC-216).
    if (rows.some((r) => r.status === 'pending')) {
      throw validationError(STRINGS.errors.invalidInput);
    }

    const totalBytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
    if (totalBytes > caps.bulkDownloadMaxBytes) {
      throw bulkLimitExceeded({
        limits: {
          maxFiles: caps.bulkDownloadMaxFiles,
          maxBytes: caps.bulkDownloadMaxBytes,
        },
      });
    }

    // Order the entries by the input `attachmentIds` so the client's
    // selection order is preserved in the zip listing. `listByIdsForProject`
    // returns rows in DB-insertion order, which is not what the user sees.
    const rowById = new Map(rows.map((r) => [r.id, r] as const));
    const orderedRows = attachmentIds.map((id) => rowById.get(id)!);

    const zipBuffer = await this.assembleZip(orderedRows);

    const zipKey = `${BULK_DOWNLOAD_PREFIX}${crypto.randomUUID()}.zip`;
    await this.storage.putObject(zipKey, zipBuffer, 'application/zip');

    return this.storage.createPresignedGet(zipKey);
  }

  /**
   * Stream each row's original object through archiver into a bounded
   * buffer. The 20 MB cap has already been enforced by the caller, so
   * bounded buffering is safe per request. Peak memory = cap × concurrent
   * bulk-downloads (e.g., 20 MB × N concurrent). Acceptable under current
   * SLA; revisit (e.g., switch to @aws-sdk/lib-storage streaming
   * multipart) if concurrency scales.
   */
  private async assembleZip(orderedRows: AttachmentRow[]): Promise<Buffer> {
    const archive = archiver('zip', {
      // Store-only — attachment originals are already compressed for
      // the photo case (JPEG/PNG/WebP) and PDFs compress poorly. Pay
      // the CPU cost only when there's upside. Level 0 keeps the 20 MB
      // cap honest: summed entry sizes are a strict upper bound.
      zlib: { level: 0 },
    });

    // Collect the zip into a buffer. S3 PutObject needs a known length;
    // the caller has already enforced the cap so bounded buffering is
    // safe per request.
    // Note: archiver emits 'warning' for non-fatal issues (missing stat,
    // etc.) — we surface them via the logger channel the caller scopes.
    const chunks: Buffer[] = [];
    const collectPromise = new Promise<Buffer>((resolve, reject) => {
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
      archive.on('warning', (warn) => {
        // ENOENT on stat is benign for streamed entries — only reject
        // on genuinely fatal warnings.
        const code = (warn as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') reject(warn);
      });
    });

    // Append entries sequentially — archiver's `append()` is not safe
    // to call concurrently across multiple streams. Sequential reads
    // also keep peak memory at one object at a time, not N.
    const usedNames = new Set<string>();
    try {
      for (const row of orderedRows) {
        const entryName = disambiguateName(row, usedNames);
        const stream = await this.storage.getObject(row.originalKey);
        archive.append(stream, { name: entryName });
        // Wait for this entry to drain before appending the next so a
        // slow storage read cannot pile up unread streams in the
        // archiver queue.
        await new Promise<void>((resolve, reject) => {
          const readable = stream as Readable;
          readable.once('end', resolve);
          readable.once('error', reject);
        });
      }
      archive.finalize();
    } catch (err) {
      // Abort the archive so the collect promise rejects and we do not
      // leak a half-built zip object into storage.
      archive.abort();
      throw err;
    }

    return collectPromise;
  }
}
