/**
 * Shared activity-feed container — used by both the project-detail
 * panel (stacked list per ui/workflow-views.md §8.4.1) and the global
 * Aktivität view (table per ui/management.md §8.13.1).
 *
 * Responsibilities:
 *  - Instantiate a per-mount audit store (see `createAuditStore()`).
 *  - Trigger a fetch with the passed-in filter on mount and on filterKey change.
 *  - Render the empty state ("Keine Aktivität") when the result set is empty.
 *  - Render rows in the requested layout.
 *  - Offer an "Ältere anzeigen" action when more rows remain.
 *
 * **Each mount owns its own store.** `createAuditStore()` is called once
 * via `useMemo` at mount time, so the global Aktivität view and an
 * overlay-mounted project-detail feed never collide through a shared
 * Zustand singleton. Each surface's `fetchList` / `appendNextPage`
 * updates only its own `entries` / `total`. See
 * `src/state/auditStore.ts` for the factory rationale.
 */

import { useEffect, useMemo } from 'react';
import { useAuthStore } from '@/state/authStore';
import { createAuditStore } from '@/state/auditStore';
import type { AuditListParams } from '@/domain/audit';
import { STRINGS } from '@/config/strings';
import { ActivityFeedRow } from './ActivityFeedRow';
import { ActivityFeedRowTable } from './ActivityFeedRowTable';
import styles from './ActivityFeed.module.css';
import tableStyles from './AuditTable.module.css';

interface Props {
  /**
   * Filter applied to the first fetch. For the project-detail feed this
   * is `{ entityType: 'project', entityId: '…' }`; for the global view
   * it is the set of active filters.
   */
  filters: AuditListParams;
  /**
   * Stable key identifying the filter context. A change refetches. The
   * component derives the key from the filters, so callers don't need
   * to specify one — but they can pass an explicit key to force a
   * refetch (e.g. on project id change).
   */
  filterKey: string;
  /** Test-id for the outer container — different between contexts. */
  testId: string;
  /**
   * Inline-style container (applies to `list` layout only). Used by the
   * project-detail panel which renders the feed inside a larger sidebar.
   */
  inline?: boolean;
  /**
   * Row layout. `list` is the stacked form used by the project-detail
   * panel (ui/workflow-views.md §8.4.1 describes a one-line-per-entry
   * list). `table` is the column form used by the global Aktivität view
   * (ui/management.md §8.13.1 names columns: timestamp, actor, entity,
   * action, payload).
   */
  layout?: 'list' | 'table';
}

/** Column count of the table layout — drives `colSpan` on empty/loader rows. */
const TABLE_COLUMN_COUNT = 5;

export function ActivityFeed({ filters, filterKey, testId, inline, layout = 'list' }: Props) {
  // One store instance per mount. The empty dependency array is
  // intentional — we never want a remount-equivalent swap of the store
  // on a prop change. Filter changes flow through `fetchList` below.
  const useStore = useMemo(() => createAuditStore(), []);

  const authUser = useAuthStore((s) => s.authUser);
  const entries = useStore((s) => s.entries);
  const total = useStore((s) => s.total);
  const loading = useStore((s) => s.loading);
  const loadingMore = useStore((s) => s.loadingMore);
  const error = useStore((s) => s.error);
  const fetchList = useStore((s) => s.fetchList);
  const appendNextPage = useStore((s) => s.appendNextPage);

  useEffect(() => {
    // Refetch whenever the filter context changes. Each instance has
    // its own monotonic counter, so a rapid sequence on this surface
    // (open A, open B) commits B's data; the other surface is
    // unaffected.
    void fetchList(filters);
    // filters is intentionally NOT in the deps array — callers pass a
    // stable `filterKey` that captures the relevant identity; otherwise
    // a new object literal on each render would refetch every paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, fetchList]);

  const callerId = authUser?.id ?? null;
  const isWorkerOnly = authUser
    ? authUser.roles.includes('worker') &&
      !authUser.roles.includes('owner') &&
      !authUser.roles.includes('office')
    : false;

  const hasMore = entries.length < total;
  const showLoader = loading && entries.length === 0;
  const showEmpty = !loading && entries.length === 0 && !error;

  if (layout === 'table') {
    return (
      <div className={tableStyles.tableWrapper} data-testid={testId}>
        {error && <div className={tableStyles.errorCell}>{error}</div>}
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th>{STRINGS.audit.colTimestamp}</th>
              <th>{STRINGS.audit.colActor}</th>
              <th>{STRINGS.audit.colEntity}</th>
              <th>{STRINGS.audit.colAction}</th>
              <th>{STRINGS.audit.colPayload}</th>
            </tr>
          </thead>
          <tbody>
            {showLoader && (
              <tr>
                <td colSpan={TABLE_COLUMN_COUNT} className={tableStyles.loaderCell}>
                  {STRINGS.ui.loading}
                </td>
              </tr>
            )}
            {showEmpty && (
              <tr>
                <td
                  colSpan={TABLE_COLUMN_COUNT}
                  className={tableStyles.emptyCell}
                  data-testid="audit-empty-state"
                >
                  {STRINGS.audit.emptyState}
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <ActivityFeedRowTable
                key={entry.id}
                entry={entry}
                callerId={callerId}
                isWorkerOnly={isWorkerOnly}
              />
            ))}
          </tbody>
        </table>
        {hasMore && (
          <div className={tableStyles.footerActions}>
            <button
              type="button"
              className={styles.loadMoreButton}
              onClick={() => void appendNextPage()}
              disabled={loadingMore}
            >
              {STRINGS.audit.loadOlder}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Default stacked-list layout (project-detail surface).
  const containerClass = inline ? styles.inlineContainer : styles.container;
  return (
    <div className={containerClass} data-testid={testId}>
      {error && <div className={styles.error}>{error}</div>}
      {showLoader && <div className={styles.loader}>{STRINGS.ui.loading}</div>}
      {showEmpty && (
        <div className={styles.emptyState} data-testid="audit-empty-state">
          {STRINGS.audit.emptyState}
        </div>
      )}
      {entries.map((entry) => (
        <ActivityFeedRow
          key={entry.id}
          entry={entry}
          callerId={callerId}
          isWorkerOnly={isWorkerOnly}
        />
      ))}
      {hasMore && (
        <div className={styles.footerActions}>
          <button
            type="button"
            className={styles.loadMoreButton}
            onClick={() => void appendNextPage()}
            disabled={loadingMore}
          >
            {STRINGS.audit.loadOlder}
          </button>
        </div>
      )}
    </div>
  );
}
