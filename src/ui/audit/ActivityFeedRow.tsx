/**
 * Single row in the activity feed / audit list.
 *
 * Renders:
 *   - One-line German description (via `describeAuditRow`).
 *   - Actor cell — displayName, `"System" + actorReason` for system
 *     rows, or the neutral `"Benutzer"` for a worker caller's view of
 *     a non-self-authored row (api.md §14.2.8, ui/workflow-views.md
 *     §8.4.1). The server has already stripped sensitive fields per
 *     role; this component renders what it receives.
 *   - German timestamp (`DD.MM.YYYY HH:mm`).
 *   - Disclosure drawer with the `{ before, after }` diff — rendered
 *     only when the API returned a non-null `payload`.
 *
 * Two `data-*` attributes drive the E2E contract (AC-185 / AC-186):
 *   - `data-self-authored` — `"true"` when `actorId === callerId`,
 *     `"false"` otherwise. The caller id comes from the auth store.
 *   - `data-has-payload`   — `"true"` iff the API returned a non-null
 *     payload; mirrors the server's role-based stripping.
 *   - `data-action`        — the raw action string, used by the
 *     purge-visibility assertion in AC-187.
 *   - `data-created-at`    — the ISO timestamp, used by AC-185's
 *     newest-first check.
 */

import { useState } from 'react';
import type { AuditEntry } from '@/domain/audit';
import { describeAuditRow } from '@/domain/auditRowDescription';
import { formatDateTimeDE } from '@/domain/dateFormat';
import { STRINGS } from '@/config/strings';
import { PayloadDrawer } from './PayloadDrawer';
import styles from './ActivityFeedRow.module.css';

interface Props {
  entry: AuditEntry;
  /**
   * The caller's own user id — used to set `data-self-authored`. Null
   * when the store is not hydrated (should not happen inside the
   * authenticated shell; kept defensive).
   */
  callerId: string | null;
  /**
   * True when the caller is a worker without owner/office. Drives the
   * neutral actor label for non-self-authored rows. When false (owner
   * / office), `actorDisplayName` is shown unconditionally.
   */
  isWorkerOnly: boolean;
}

function entityTypeLabel(entityType: AuditEntry['entityType']): string {
  switch (entityType) {
    case 'project':
      return STRINGS.audit.entityProject;
    case 'customer':
      return STRINGS.audit.entityCustomer;
    case 'user':
      return STRINGS.audit.entityUser;
    case 'project_worker':
      return STRINGS.audit.entityProjectWorker;
  }
}

function resolveActorLabel(entry: AuditEntry, callerId: string | null, isWorkerOnly: boolean) {
  if (entry.actorKind === 'system') {
    return {
      kind: 'system' as const,
      label: STRINGS.audit.system,
      reason: entry.actorReason,
    };
  }
  // actor is a user
  const isSelf = entry.actorId !== null && entry.actorId === callerId;
  if (isWorkerOnly) {
    // Worker callers: own rows render their own display name (if server
    // supplied one; otherwise fall through to neutral). Non-self rows
    // carry `actorId = null` per api.md §14.2.8 — render the neutral
    // "Benutzer" label.
    if (isSelf) {
      return {
        kind: 'user' as const,
        label: entry.actorDisplayName ?? STRINGS.audit.userNeutral,
        reason: null,
      };
    }
    return { kind: 'user' as const, label: STRINGS.audit.userNeutral, reason: null };
  }
  // Owner / office — the server supplies displayName on user-actor rows.
  return {
    kind: 'user' as const,
    label: entry.actorDisplayName ?? STRINGS.audit.userNeutral,
    reason: null,
  };
}

export function ActivityFeedRow({ entry, callerId, isWorkerOnly }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const description = describeAuditRow({
    action: entry.action,
    payload: entry.payload,
    entityType: entry.entityType,
  });
  const hasPayload = entry.payload !== null;
  const isSelfAuthored = entry.actorId !== null && entry.actorId === callerId;
  const actor = resolveActorLabel(entry, callerId, isWorkerOnly);

  return (
    <div
      className={styles.row}
      data-testid={`activity-feed-row-${entry.id}`}
      data-action={entry.action}
      data-self-authored={isSelfAuthored ? 'true' : 'false'}
      data-has-payload={hasPayload ? 'true' : 'false'}
      data-created-at={entry.createdAt}
    >
      <div className={styles.headerLine}>
        <span className={styles.description}>{description}</span>
        <span className={styles.timestamp}>{formatDateTimeDE(entry.createdAt)}</span>
      </div>
      <div className={styles.metaLine}>
        <span className={actor.kind === 'system' ? styles.actorSystem : styles.actor}>
          {actor.label}
        </span>
        {actor.reason && <span className={styles.actorReason}>({actor.reason})</span>}
        <span className={styles.entity}>
          <span className={styles.entityLabel}>{entityTypeLabel(entry.entityType)}</span>
        </span>
      </div>
      {hasPayload && (
        <button
          type="button"
          className={styles.drawerToggle}
          data-testid="activity-feed-drawer-toggle"
          onClick={() => setDrawerOpen((open) => !open)}
          aria-expanded={drawerOpen}
        >
          {drawerOpen ? STRINGS.audit.detailsHide : STRINGS.audit.detailsShow}
        </button>
      )}
      {hasPayload && drawerOpen && (
        <div
          className={styles.drawerContent}
          data-testid="activity-feed-drawer-content"
          role="region"
        >
          <PayloadDrawer payload={entry.payload} />
        </div>
      )}
    </div>
  );
}
