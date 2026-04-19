/**
 * Shared activity-feed list — used by both the project-detail panel
 * and the global Aktivität view.
 *
 * Responsibilities:
 *  - Trigger a fetch with the passed-in filter on mount.
 *  - Render the empty state when the scoped result set is empty.
 *  - Render one row per entry (reverse-chrono; the server already
 *    orders newest-first).
 *  - Offer an "Ältere anzeigen" action when more rows remain.
 *
 * The store is the single source of truth for entries/total/loading.
 * Parent components pass a `filterKey` so the feed refetches when
 * the caller context changes (e.g. opening a different project).
 */

import { useEffect } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useAuditStore } from '@/state/auditStore';
import type { AuditListParams } from '@/domain/audit';
import { STRINGS } from '@/config/strings';
import { ActivityFeedRow } from './ActivityFeedRow';
import styles from './ActivityFeed.module.css';

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
   * Inline-style container? Used by the project-detail panel which
   * renders the feed inside a larger sidebar. The global view uses the
   * default framing.
   */
  inline?: boolean;
}

export function ActivityFeed({ filters, filterKey, testId, inline }: Props) {
  const authUser = useAuthStore((s) => s.authUser);
  const entries = useAuditStore((s) => s.entries);
  const total = useAuditStore((s) => s.total);
  const loading = useAuditStore((s) => s.loading);
  const loadingMore = useAuditStore((s) => s.loadingMore);
  const error = useAuditStore((s) => s.error);
  const fetchList = useAuditStore((s) => s.fetchList);
  const appendNextPage = useAuditStore((s) => s.appendNextPage);

  useEffect(() => {
    // Refetch whenever the filter context changes. The store's monotonic
    // counter discards stale responses, so a rapid sequence (open A, open
    // B) commits B's data.
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

  const containerClass = inline ? styles.inlineContainer : styles.container;
  const hasMore = entries.length < total;

  return (
    <div className={containerClass} data-testid={testId}>
      {error && <div className={styles.error}>{error}</div>}
      {loading && entries.length === 0 && <div className={styles.loader}>{STRINGS.ui.loading}</div>}
      {!loading && entries.length === 0 && !error && (
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
