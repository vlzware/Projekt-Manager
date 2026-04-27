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

/** Format an ISO date as a German relative-time label ("vor 3 Tagen",
 *  "vor 5 Stunden"). Uses Intl.RelativeTimeFormat — built-in, no dep. */
function relativeFromNow(iso: string, now: Date = new Date()): string {
  const fmt = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
  const then = new Date(iso).getTime();
  const diffSec = Math.round((then - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return fmt.format(diffSec, 'second');
  if (abs < 60 * 60) return fmt.format(Math.round(diffSec / 60), 'minute');
  if (abs < 60 * 60 * 24) return fmt.format(Math.round(diffSec / 3600), 'hour');
  return fmt.format(Math.round(diffSec / 86400), 'day');
}

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

  useEffect(() => {
    void fetchTrashForProject(projectId);
  }, [fetchTrashForProject, projectId]);

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

      {items === undefined ? null : items.length === 0 ? (
        <p className={styles.emptyState}>{STRINGS.attachments.papierkorbEmpty}</p>
      ) : (
        <div className={styles.binaryTableScroll}>
          <table className={styles.binaryTable}>
            <thead>
              <tr>
                <th>{STRINGS.attachments.binarySectionTitle}</th>
                <th>{STRINGS.attachments.uploadLabel}</th>
                <th>{STRINGS.attachments.activity}</th>
                <th aria-label={STRINGS.attachments.restore} />
              </tr>
            </thead>
            <tbody>
              {items.map((att) => (
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
