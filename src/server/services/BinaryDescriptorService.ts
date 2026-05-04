/**
 * Binary-descriptors service — paginated read surface backing
 * `GET /api/export/binary-descriptors` (api.md §14.2.4 / verification.md
 * AC-248). Companion to the unified `Export` envelope: the browser-side
 * "Vollständiger Export" flow drains `data.json` from `/api/export` and
 * the binary set from this surface in lockstep.
 *
 * Per-row shape:
 *   - Always: `attachmentId`, `projectId`, `projectNumber`,
 *     `projectTitle`, `fileName`, `sizeBytes`.
 *   - AND either the fetch triple
 *     (`originalUrl` + `originalDekMaterial` + `expiresAt`)
 *     OR `error = 'DEK_UNWRAP_FAILED'`. Mutually exclusive — the
 *     discriminator drives the client's per-row skip path.
 *
 * Behaviour:
 *   - Iterates `status='ready'` rows only (`pending`, `hidden` excluded
 *     by construction). Order is ascending `(createdAt, id)`.
 *   - Cursor is opaque to the client — base64 of
 *     `<iso>|<uuid>|<totalCount>|<totalSizeBytes>`. The server
 *     decodes/encodes; a malformed `after` returns `422 VALIDATION_ERROR`.
 *   - Pagination: default + ceiling per `[C]` `exportAllPerPageDefault`
 *     / `exportAllPerPageCeiling`. `limit` outside `(0, ceiling]`
 *     returns `422 VALIDATION_ERROR`.
 *   - Totals (`totalCount`, `totalSizeBytes`) are PINNED at first-page
 *     composition (single aggregate over `status='ready'`) and ride the
 *     cursor for every subsequent page in the iteration. A row inserted,
 *     deleted, or status-changed mid-drain drifts the live state away
 *     from the pinned totals, but the totals themselves do not change
 *     within the iteration (api.md §14.2.4 stability invariant /
 *     AC-248).
 *   - Per-row unwrap failure → emit inline `error='DEK_UNWRAP_FAILED'`.
 *     Wholesale failure (operator binary `age` identity not loaded)
 *     bubbles as 5xx — the boot probe makes this unreachable in steady
 *     state.
 *   - The descriptor surface is unscoped: its caller must hold
 *     `data:export`, and both holding roles (owner / office) are
 *     unscoped under `attachmentScopeForCaller` (AC-217). The route
 *     layer enforces the permission gate; this service additionally
 *     fail-fasts via `isUnscoped(caller)` so a future scoped role
 *     gaining `data:export` cannot leak rows past the seam — same
 *     tripwire as `ExportService`.
 *   - No `audit_log` row written (parity with `Export`, AC-177 invariant).
 */

import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { attachments, projects } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import { isUnscoped } from '../repositories/scope.js';
import { isKnownWrappedDekVersion } from '../../domain/attachments.js';
import { type AttachmentStorageClient } from '../storage/client.js';
import { KeyEnvelopeService, KeyEnvelopeUnwrapError } from './KeyEnvelopeService.js';
import { serverError, validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { ATTACHMENT_CONFIG } from '../../config/attachmentConfig.js';

/**
 * Wire shape per `BinaryDescriptor` in api.md §14.2.4. The fetch triple
 * (`originalUrl` + `originalDekMaterial` + `expiresAt`) and the `error`
 * tag are mutually exclusive — the route response shape pins the
 * discriminator in tests, the service produces one or the other per row.
 */
export interface BinaryDescriptor {
  attachmentId: string;
  projectId: string;
  projectNumber: string;
  projectTitle: string;
  fileName: string;
  sizeBytes: number;
  originalUrl?: string;
  originalDekMaterial?: string;
  expiresAt?: string;
  error?: 'DEK_UNWRAP_FAILED';
}

export interface BinaryDescriptorPage {
  entries: BinaryDescriptor[];
  nextCursor: string | null;
  totalCount: number;
  totalSizeBytes: number;
}

export interface BinaryDescriptorListInput {
  /** Opaque base64 cursor from a prior page's `nextCursor`; absent on first page. */
  after?: string;
  /** Per-page entry ceiling; defaults to `[C]` `exportAllPerPageDefault`. */
  limit?: number;
}

export interface BinaryDescriptorServiceDeps {
  db: Database;
  storage: AttachmentStorageClient;
  binaryAgeRecipient: string;
  binaryAgeIdentityPath: string;
}

interface DecodedCursor {
  createdAt: Date;
  id: string;
  /** Iteration-pinned totals — sticky across all pages within one drain (api.md §14.2.4). */
  totalCount: number;
  totalSizeBytes: number;
}

/**
 * Decode the opaque `after` token. Format: base64 of
 * `<iso>|<uuid>|<totalCount>|<totalSizeBytes>` (4 parts). Halves are all
 * `|`-free by their own grammars (ISO 8601, UUID, integers). Totals are
 * encoded so they ride the iteration verbatim — first-page composition
 * computes them once and they survive across every subsequent page
 * regardless of mid-drain mutations (the spec's stability invariant).
 * Reject anything malformed with `422 VALIDATION_ERROR`.
 */
function decodeCursor(raw: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    throw validationError(STRINGS.errors.invalidInput);
  }
  // Round-trip check — anything that didn't survive base64 cleanly is a
  // forgery (Buffer.from silently drops non-base64 bytes; the encode-back
  // mismatch is the canonical detector).
  if (Buffer.from(decoded, 'utf-8').toString('base64') !== raw) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const parts = decoded.split('|');
  if (parts.length !== 4) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const [iso, id, totalCountRaw, totalSizeBytesRaw] = parts as [string, string, string, string];
  // Date.parse accepts plenty of garbage ("not-a-real-cursor" included
  // when base64-decoded happens to roundtrip). Pin the shape to ISO 8601
  // by re-serialising and comparing — the cursors we issue all use
  // `Date.toISOString()`, so the round-trip is exact.
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const createdAt = new Date(ts);
  if (createdAt.toISOString() !== iso) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  // UUID v4 shape — same regex the schema uses (case-insensitive). A
  // non-UUID id half is a forgery; surface as VALIDATION_ERROR rather
  // than fail at the SQL layer.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  // Totals are non-negative integers in decimal. Reject leading zeros
  // (other than the literal `0`), signs, or non-digit chars — same
  // strictness as cursor itself; otherwise two distinct cursor strings
  // could encode the same iteration.
  if (!/^(0|[1-9][0-9]*)$/.test(totalCountRaw) || !/^(0|[1-9][0-9]*)$/.test(totalSizeBytesRaw)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const totalCount = Number(totalCountRaw);
  const totalSizeBytes = Number(totalSizeBytesRaw);
  if (!Number.isSafeInteger(totalCount) || !Number.isSafeInteger(totalSizeBytes)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  return { createdAt, id, totalCount, totalSizeBytes };
}

function encodeCursor(
  createdAt: Date,
  id: string,
  totalCount: number,
  totalSizeBytes: number,
): string {
  return Buffer.from(
    `${createdAt.toISOString()}|${id}|${totalCount}|${totalSizeBytes}`,
    'utf-8',
  ).toString('base64');
}

export class BinaryDescriptorService {
  private readonly db: Database;
  private readonly storage: AttachmentStorageClient;
  private readonly binaryAgeRecipient: string;
  private readonly binaryAgeIdentityPath: string;

  constructor(deps: BinaryDescriptorServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.binaryAgeRecipient = deps.binaryAgeRecipient;
    this.binaryAgeIdentityPath = deps.binaryAgeIdentityPath;
  }

  /**
   * Construct a per-request `KeyEnvelopeService` against the
   * operator-loaded identity path. Mirrors `AttachmentService` — no
   * temp-file owned (the identity file is borrowed), no `close()`
   * required.
   */
  private envelopeService(): KeyEnvelopeService {
    return new KeyEnvelopeService({
      recipient: this.binaryAgeRecipient,
      identityPath: this.binaryAgeIdentityPath,
    });
  }

  async listPage(
    caller: AuthUser,
    input: BinaryDescriptorListInput,
  ): Promise<BinaryDescriptorPage> {
    // Tripwire matching ExportService: the descriptor surface is unscoped
    // by spec because the admitting roles (owner / office) are unscoped
    // under `attachmentScopeForCaller`. If permission churn ever grants
    // `data:export` to a scoped role, fail loud here rather than silently
    // leak rows the role's scope predicate would normally hide.
    if (!isUnscoped(caller)) {
      throw new Error(
        `BinaryDescriptorService.listPage must be invoked with an unscoped caller; got roles=[${caller.roles.join(', ')}]`,
      );
    }

    const limit = this.resolveLimit(input.limit);
    const cursor = input.after !== undefined ? decodeCursor(input.after) : null;

    // The `(createdAt, id)` strict-greater predicate is the cursor
    // tiebreaker. Without the secondary `id` half, two rows sharing an
    // identical `createdAt` would either skip or duplicate at a page
    // boundary (covered by the `cursor stability under identical
    // createdAt` test).
    const cursorPredicate: SQL | undefined = cursor
      ? or(
          gt(attachments.createdAt, cursor.createdAt),
          and(eq(attachments.createdAt, cursor.createdAt), gt(attachments.id, cursor.id)),
        )
      : undefined;

    // Fetch one extra row past `limit` so the page knows whether to emit
    // `nextCursor` — cheaper than a follow-up COUNT and consistent with
    // the same-shape pagination on other endpoints.
    const conditions = [eq(attachments.status, 'ready')];
    if (cursorPredicate) conditions.push(cursorPredicate);

    // Snapshot acquisition: page rows AND (on first page) the totals
    // aggregate run inside ONE `repeatable read` read-only transaction,
    // so they observe a single point-in-time. Without the txn wrap, a
    // concurrent insert / delete between the two SELECTs would let
    // `totalCount` disagree with what page 1 actually returns. Same
    // pattern as `ExportService.export`. The unwrap loop runs OUTSIDE
    // the txn — holding it open across N `age --decrypt` subprocesses
    // would be a self-inflicted lock-time blow-up.
    const { pageRows, hasMore, totalCount, totalSizeBytes } = await this.db.transaction(
      async (tx) => {
        // Sequential — drizzle runs each tx query on the same pg client,
        // so Promise.all would trigger pg's "concurrent query"
        // deprecation. Mirrors the ExportService transaction shape.
        const rawRows = await tx
          .select({
            id: attachments.id,
            projectId: attachments.projectId,
            projectNumber: projects.number,
            projectTitle: projects.title,
            filename: attachments.filename,
            sizeBytes: attachments.sizeBytes,
            originalKey: attachments.originalKey,
            wrappedDek: attachments.wrappedDek,
            wrappedDekVersion: attachments.wrappedDekVersion,
            createdAt: attachments.createdAt,
          })
          .from(attachments)
          .innerJoin(projects, eq(attachments.projectId, projects.id))
          .where(and(...conditions))
          .orderBy(asc(attachments.createdAt), asc(attachments.id))
          .limit(limit + 1);

        const hasMoreLocal = rawRows.length > limit;
        const pageRowsLocal = hasMoreLocal ? rawRows.slice(0, limit) : rawRows;

        // Totals are PINNED at first-page composition and ride the
        // cursor for every subsequent page in the iteration (api.md
        // §14.2.4 / AC-248 stability invariant). First page → run the
        // aggregate inside this same snapshot. Subsequent pages → read
        // totals out of the cursor without a server round-trip.
        if (cursor === null) {
          const totalsResult = await tx
            .select({
              totalCount: sql<number>`COUNT(*)::int`,
              totalSizeBytes: sql<number>`COALESCE(SUM(${attachments.sizeBytes}), 0)::bigint`,
            })
            .from(attachments)
            .where(eq(attachments.status, 'ready'));
          const totals = totalsResult[0] ?? { totalCount: 0, totalSizeBytes: 0 };
          // SUM of bigint comes back as a string from pg; coerce to
          // number for the wire shape. totalSizeBytes is BIGINT in pg;
          // assert it fits MAX_SAFE_INTEGER. Aggregate ceiling is a
          // function of [C] perFileCapBytes × max attachment count.
          // Mirrors the cursor decoder's safe-integer assertion so the
          // producing site cannot quietly emit values the decoder
          // would later reject.
          const totalCountCoerced = Number(totals.totalCount);
          const totalSizeBytesCoerced = Number(totals.totalSizeBytes);
          if (
            !Number.isSafeInteger(totalCountCoerced) ||
            !Number.isSafeInteger(totalSizeBytesCoerced)
          ) {
            throw serverError();
          }
          return {
            pageRows: pageRowsLocal,
            hasMore: hasMoreLocal,
            totalCount: totalCountCoerced,
            totalSizeBytes: totalSizeBytesCoerced,
          };
        }
        return {
          pageRows: pageRowsLocal,
          hasMore: hasMoreLocal,
          totalCount: cursor.totalCount,
          totalSizeBytes: cursor.totalSizeBytes,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    // Per-row unwrap + presigned URL. A `KeyEnvelopeUnwrapError` on the
    // row's envelope (corrupt bytes, recipient mismatch) becomes the
    // inline `error='DEK_UNWRAP_FAILED'` discriminator; anything else
    // (operator-condition wholesale failure) bubbles as 5xx via
    // `serverError()` — the route layer catches and surfaces.
    const envelope = this.envelopeService();
    const entries: BinaryDescriptor[] = [];
    for (const row of pageRows) {
      const descriptor = await this.composeEntry(envelope, row);
      entries.push(descriptor);
    }

    const nextCursor = hasMore
      ? encodeCursor(
          pageRows[pageRows.length - 1]!.createdAt,
          pageRows[pageRows.length - 1]!.id,
          totalCount,
          totalSizeBytes,
        )
      : null;

    return {
      entries,
      nextCursor,
      totalCount,
      totalSizeBytes,
    };
  }

  /**
   * Per-row composition: validate the envelope-format discriminator,
   * unwrap the DEK, sign the presigned-GET. A `KeyEnvelopeUnwrapError`
   * (per-row corruption, recipient mismatch, format gate refusal) collapses
   * to the inline `error='DEK_UNWRAP_FAILED'` shape per AC-248. Any other
   * failure (missing operator identity, `age` binary absent) is a wholesale
   * fault — propagate as 5xx via `serverError()`.
   */
  private async composeEntry(
    envelope: KeyEnvelopeService,
    row: {
      id: string;
      projectId: string;
      projectNumber: string;
      projectTitle: string;
      filename: string;
      sizeBytes: number;
      originalKey: string;
      wrappedDek: string | null;
      wrappedDekVersion: number;
      createdAt: Date;
    },
  ): Promise<BinaryDescriptor> {
    const base = {
      attachmentId: row.id,
      projectId: row.projectId,
      projectNumber: row.projectNumber,
      projectTitle: row.projectTitle,
      fileName: row.filename,
      sizeBytes: row.sizeBytes,
    };

    // Format-version gate (ADR-0024). A row on an unknown wrapping
    // format collapses to the per-row error tag — same shape as
    // corrupted bytes. The download-url path uses the same gate.
    if (!isKnownWrappedDekVersion(row.wrappedDekVersion) || !row.wrappedDek) {
      return { ...base, error: 'DEK_UNWRAP_FAILED' };
    }

    let dekBytes: Uint8Array;
    try {
      dekBytes = await envelope.unwrap(Buffer.from(row.wrappedDek, 'base64'));
    } catch (err) {
      if (err instanceof KeyEnvelopeUnwrapError) {
        // Per-row corruption / recipient mismatch — surface inline.
        return { ...base, error: 'DEK_UNWRAP_FAILED' };
      }
      // Wholesale failure (operator-side condition) — escalate.
      throw serverError();
    }

    // Sign the presigned GET against the storage public endpoint. The
    // download triggers a Content-Disposition with the plaintext file
    // name (mirrors `AttachmentService.issueDownloadUrl`), so the
    // browser saves the ciphertext under a recognisable name even
    // before client-side decrypt.
    const presigned = await this.storage.createPresignedGet(
      row.originalKey,
      undefined,
      row.filename,
    );

    return {
      ...base,
      originalUrl: presigned.url,
      originalDekMaterial: Buffer.from(dekBytes).toString('base64'),
      expiresAt: presigned.expiresAt,
    };
  }

  /**
   * Resolve the page limit, enforcing the `[C]` ceiling. `limit` outside
   * `(0, ceiling]` returns `422 VALIDATION_ERROR` — the test pins both
   * the lower-bound rejection (`limit=0`, negatives) and the upper-bound
   * rejection (`limit=ceiling+1`).
   */
  private resolveLimit(raw: number | undefined): number {
    if (raw === undefined) return ATTACHMENT_CONFIG.exportAllPerPageDefault;
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw > ATTACHMENT_CONFIG.exportAllPerPageCeiling
    ) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    return raw;
  }
}
