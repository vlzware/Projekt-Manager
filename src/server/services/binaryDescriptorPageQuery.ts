/**
 * Snapshot-acquisition query for `BinaryDescriptorService.listPage`
 * (api.md §14.2.4 / AC-248). Runs the page rows AND (on first page)
 * the totals aggregate inside ONE `repeatable read` read-only
 * transaction so they observe a single point-in-time. Without the txn
 * wrap, a concurrent insert / delete between the two SELECTs would let
 * `totalCount` disagree with what page 1 actually returns. Same
 * pattern as `ExportService.export`. The unwrap loop runs OUTSIDE the
 * txn — holding it open across N `age --decrypt` subprocesses would
 * be a self-inflicted lock-time blow-up.
 *
 * Totals are PINNED at first-page composition and ride the cursor for
 * every subsequent page in the iteration. First page → run the
 * aggregate inside this same snapshot. Subsequent pages → read totals
 * out of the cursor without a server round-trip. The
 * `Number.isSafeInteger` guard on the producing site mirrors the
 * decoder's assertion so the producer cannot quietly emit values the
 * decoder would later reject.
 */

import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { attachments, projects } from '../db/schema.js';
import { serverError } from '../errors.js';
import type { BinaryDescriptorCursor } from './binaryDescriptorCursor.js';
import type { BinaryDescriptorRow } from './binaryDescriptorEntry.js';

export interface BinaryDescriptorPageSnapshot {
  pageRows: BinaryDescriptorRow[];
  hasMore: boolean;
  totalCount: number;
  totalSizeBytes: number;
}

/**
 * Fetch one page of `status='ready'` attachment rows ordered by
 * ascending `(createdAt, id)`, plus pinned totals on the first page.
 * `cursor=null` triggers a totals aggregate within the same snapshot;
 * a non-null cursor reuses its pinned totals verbatim.
 */
export async function fetchPageAndTotals(
  db: Database,
  cursor: BinaryDescriptorCursor | null,
  limit: number,
): Promise<BinaryDescriptorPageSnapshot> {
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

  return db.transaction(
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

      const hasMore = rawRows.length > limit;
      const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;

      if (cursor !== null) {
        return {
          pageRows,
          hasMore,
          totalCount: cursor.totalCount,
          totalSizeBytes: cursor.totalSizeBytes,
        };
      }

      // First page — compute totals inside the same snapshot.
      const totalsResult = await tx
        .select({
          totalCount: sql<number>`COUNT(*)::int`,
          totalSizeBytes: sql<number>`COALESCE(SUM(${attachments.sizeBytes}), 0)::bigint`,
        })
        .from(attachments)
        .where(eq(attachments.status, 'ready'));
      const totals = totalsResult[0] ?? { totalCount: 0, totalSizeBytes: 0 };
      // SUM of bigint comes back as a string from pg; coerce to number
      // for the wire shape. totalSizeBytes is BIGINT in pg; assert it
      // fits MAX_SAFE_INTEGER. Aggregate ceiling is a function of [C]
      // perFileCapBytes × max attachment count. Mirrors the cursor
      // decoder's safe-integer assertion so the producing site cannot
      // quietly emit values the decoder would later reject.
      const totalCount = Number(totals.totalCount);
      const totalSizeBytes = Number(totals.totalSizeBytes);
      if (!Number.isSafeInteger(totalCount) || !Number.isSafeInteger(totalSizeBytes)) {
        throw serverError();
      }
      return { pageRows, hasMore, totalCount, totalSizeBytes };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
