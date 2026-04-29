/**
 * Papierkorb — hidden attachments on a project, restore one click away.
 * ADR-0022: hide is a soft state-flip + storage delete-marker; restore
 * is a server-side `copyFromVersion` from the persisted version-id pair.
 *
 * Owner / office only — the route enforces `attachment:trash`. The
 * containing tab is also gated, so this component never renders for a
 * worker or bookkeeper. No confirmation on restore — restore is
 * reversible (re-hide), so a confirm-dialog would be friction without
 * value.
 */

import { useCallback, useEffect, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_LABELS } from '@/domain/attachments';
import type { Attachment, AttachmentLabel } from '@/domain/types';
import { useAttachmentStore } from '@/state/attachmentStore';
import styles from './ProjectDetail.module.css';

const LABEL_BY_VALUE = new Map<AttachmentLabel, string>(
  ATTACHMENT_LABELS.map((l) => [l.value, l.label]),
);

interface PapierkorbProps {
  projectId: string;
}

/**
 * Reusable Intl formatter — instantiation is non-trivial and was
 * previously created on every row render. Hoist to module scope so the
 * cost is paid once per page lifecycle, not once per (rows × renders).
 */
const RELATIVE_FMT = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });

/** Format an ISO date as a German relative-time label ("vor 3 Tagen",
 *  "vor 5 Stunden"). Uses Intl.RelativeTimeFormat — built-in, no dep. */
function relativeFromNow(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.round((then - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return RELATIVE_FMT.format(diffSec, 'second');
  if (abs < 60 * 60) return RELATIVE_FMT.format(Math.round(diffSec / 60), 'minute');
  if (abs < 60 * 60 * 24) return RELATIVE_FMT.format(Math.round(diffSec / 3600), 'hour');
  return RELATIVE_FMT.format(Math.round(diffSec / 86400), 'day');
}

/**
 * Local fetch state. Distinguishes the four observable surfaces:
 *   - `loading` — fetch in progress, render a spinner
 *   - `ready`   — fetch resolved, render the (possibly empty) list
 *   - `error`   — network or server error, render a retry banner
 *   - `forbidden` — 403, defense-in-depth for direct API calls
 *
 * Kept component-local rather than in the store so concurrent
 * actions (a hide on a different surface, an upload error) don't
 * overwrite the trash-fetch state by reaching for the shared
 * `state.error` slot.
 */
type FetchState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden' };

export function Papierkorb({ projectId }: PapierkorbProps) {
  // `undefined` = never fetched, `[]` = fetched-empty, otherwise the
  // hidden rows. The selector is already stable (Zustand returns the
  // same array reference until `set` produces a new one), so no useMemo.
  const items = useAttachmentStore((s) => s.hiddenByProject[projectId]);
  const fetchTrashForProject = useAttachmentStore((s) => s.fetchTrashForProject);
  const restoreAttachment = useAttachmentStore((s) => s.restoreAttachment);

  // Per-row in-flight tracking. A double-click on Restore would otherwise
  // dispatch the mutation twice — the second call wins the optimistic
  // update race and the UI can briefly show the row in the live list
  // twice. Disabling the button + flagging `aria-busy` is the same
  // pattern AssignedWorkerEditor / management forms use.
  const [pending, setPending] = useState<Set<string>>(new Set());
  // The page eagerly fetches the trash for owner / office to populate
  // the tab badge (`ProjectDetailPage`), so the cache is usually warm
  // by the time this tab opens. Initialise from cached state to avoid
  // a brief loading flash on every tab toggle: `items !== undefined`
  // means a prior fetch already settled (empty array still counts).
  const [fetchState, setFetchState] = useState<FetchState>(() =>
    items === undefined ? { kind: 'loading' } : { kind: 'ready' },
  );

  const runFetch = useCallback(async () => {
    setFetchState({ kind: 'loading' });
    const outcome = await fetchTrashForProject(projectId);
    if (outcome.kind === 'forbidden') {
      setFetchState({ kind: 'forbidden' });
      return;
    }
    if (outcome.kind === 'error') {
      setFetchState({ kind: 'error', message: outcome.message });
      return;
    }
    setFetchState({ kind: 'ready' });
  }, [fetchTrashForProject, projectId]);

  useEffect(() => {
    // Skip the duplicate fetch when the cache is already populated by
    // the page-level eager fetch. The retry banner still uses
    // `runFetch` directly.
    if (items !== undefined) return;
    void runFetch();
    // `items` intentionally not in deps: we only want to gate the
    // mount-time fetch, not retrigger when the cache later mutates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runFetch]);

  const handleRestore = useCallback(
    async (att: Attachment) => {
      // Guard against the React 18 strict-mode double-invoke and a fast
      // double-click; both produce overlapping calls that the store's
      // optimistic move handles incorrectly.
      if (pending.has(att.id)) return;
      setPending((prev) => new Set(prev).add(att.id));
      try {
        await restoreAttachment(projectId, att.id);
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(att.id);
          return next;
        });
      }
    },
    [pending, projectId, restoreAttachment],
  );

  return (
    <section
      aria-label={STRINGS.attachments.papierkorbHeading}
      data-testid="project-detail-papierkorb"
      className={styles.binarySection}
    >
      <h3 className={styles.regionHeading}>{STRINGS.attachments.papierkorbHeading}</h3>

      {fetchState.kind === 'loading' && items === undefined ? (
        <p
          className={styles.emptyState}
          data-testid="papierkorb-loading"
          role="status"
          aria-live="polite"
        >
          {STRINGS.ui.loading}
        </p>
      ) : fetchState.kind === 'forbidden' ? (
        <p className={styles.emptyState} data-testid="papierkorb-forbidden" role="alert">
          {STRINGS.auth.notPermitted}
        </p>
      ) : fetchState.kind === 'error' ? (
        <div className={styles.errorBanner} data-testid="papierkorb-error" role="alert">
          <span>{fetchState.message}</span>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void runFetch()}
            data-testid="papierkorb-retry"
          >
            {STRINGS.attachments.uploadRetry}
          </button>
        </div>
      ) : (items ?? []).length === 0 ? (
        <p className={styles.emptyState} data-testid="papierkorb-empty">
          {STRINGS.attachments.papierkorbEmpty}
        </p>
      ) : (
        <div className={styles.binaryTableScroll}>
          <table className={styles.binaryTable}>
            <thead>
              <tr>
                <th>{STRINGS.attachments.colFileName}</th>
                <th>{STRINGS.attachments.colLabel}</th>
                <th>{STRINGS.attachments.colHidden}</th>
                <th aria-label={STRINGS.attachments.restore} />
              </tr>
            </thead>
            <tbody>
              {(items ?? []).map((att) => (
                <tr key={att.id} data-testid={`papierkorb-row-${att.id}`}>
                  <td>{att.fileName}</td>
                  <td>{LABEL_BY_VALUE.get(att.label) ?? att.label}</td>
                  <td>
                    {att.hiddenAt
                      ? STRINGS.attachments.hiddenAtLabel(relativeFromNow(att.hiddenAt))
                      : ''}
                  </td>
                  <td className={styles.rowActions}>
                    <button
                      type="button"
                      onClick={() => void handleRestore(att)}
                      data-testid={`papierkorb-restore-${att.id}`}
                      disabled={pending.has(att.id)}
                      aria-busy={pending.has(att.id)}
                    >
                      {STRINGS.attachments.restore}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
