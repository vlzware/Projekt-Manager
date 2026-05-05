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
 *   - Cursor codec lives in `binaryDescriptorCursor.ts` (opaque base64,
 *     iteration-pinned totals; malformed `after` returns 422).
 *   - Snapshot acquisition (page rows + first-page totals in one
 *     `repeatable read` txn) lives in `binaryDescriptorPageQuery.ts`.
 *   - Per-row composition (DEK unwrap + presigned GET) lives in
 *     `binaryDescriptorEntry.ts` — same `BinaryDescriptor` discriminator
 *     used here.
 *   - Pagination: default + ceiling per `[C]` `exportAllPerPageDefault`
 *     / `exportAllPerPageCeiling`. `limit` outside `(0, ceiling]`
 *     returns `422 VALIDATION_ERROR`.
 *   - Totals (`totalCount`, `totalSizeBytes`) are PINNED at first-page
 *     composition and ride the cursor for every subsequent page in the
 *     iteration. A row inserted, deleted, or status-changed mid-drain
 *     drifts the live state away from the pinned totals, but the totals
 *     themselves do not change within the iteration (api.md §14.2.4
 *     stability invariant / AC-248).
 *   - The descriptor surface is unscoped: its caller must hold
 *     `data:export`, and both holding roles (owner / office) are
 *     unscoped under `attachmentScopeForCaller` (AC-217). The route
 *     layer enforces the permission gate; this service additionally
 *     fail-fasts via `isUnscoped(caller)` so a future scoped role
 *     gaining `data:export` cannot leak rows past the seam — same
 *     tripwire as `ExportService`.
 *   - No `audit_log` row written (parity with `Export`, AC-177 invariant).
 */

import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import { isUnscoped } from '../repositories/scope.js';
import { type AttachmentStorageClient } from '../storage/client.js';
import { KeyEnvelopeService } from './KeyEnvelopeService.js';
import { validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { ATTACHMENT_CONFIG } from '../../config/attachmentConfig.js';
import { decodeCursor, encodeCursor } from './binaryDescriptorCursor.js';
import { composeEntry } from './binaryDescriptorEntry.js';
import { fetchPageAndTotals } from './binaryDescriptorPageQuery.js';

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

    const { pageRows, hasMore, totalCount, totalSizeBytes } = await fetchPageAndTotals(
      this.db,
      cursor,
      limit,
    );

    // Per-row unwrap + presigned URL. A `KeyEnvelopeUnwrapError` on the
    // row's envelope (corrupt bytes, recipient mismatch) becomes the
    // inline `error='DEK_UNWRAP_FAILED'` discriminator; anything else
    // (operator-condition wholesale failure) bubbles as 5xx via
    // `serverError()` — the route layer catches and surfaces.
    const envelope = this.envelopeService();
    const entries: BinaryDescriptor[] = [];
    for (const row of pageRows) {
      const descriptor = await composeEntry(envelope, this.storage, row);
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
