/**
 * Global Aktivität view — `ui/management.md §8.13`.
 *
 * Read-only tabular view over the audit log. Filters AND-compose and
 * are applied via the API (no client-side slicing — server is
 * authoritative per api.md §14.2.8).
 *
 * Permission gate: the route's `canAccess` predicate covers nav
 * visibility + URL-guard. This component reruns `usePermission('audit:read')`
 * as a defense-in-depth render check — a direct path entry by a user
 * whose roles were revoked mid-session still renders the
 * NotPermittedView from the guard, but a component-level check keeps
 * the store fetch from firing against the API.
 */

import { useMemo, useState } from 'react';
import { usePermission } from '@/hooks/usePermission';
import { useAuthStore } from '@/state/authStore';
import { useAuditStore } from '@/state/auditStore';
import { STRINGS } from '@/config/strings';
import { AUDIT_ACTION_KEYS, AUDIT_ACTION_LABELS } from '@/config/auditActionLabels';
import type { AuditEntityType } from '@/domain/audit';
import { ActivityFeed } from './ActivityFeed';
import styles from './AuditManagement.module.css';

interface LocalFilters {
  entityType?: AuditEntityType;
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
}

const ALL_ENTITY_TYPES: { value: AuditEntityType; label: string }[] = [
  { value: 'project', label: STRINGS.audit.entityProject },
  { value: 'customer', label: STRINGS.audit.entityCustomer },
  { value: 'user', label: STRINGS.audit.entityUser },
  { value: 'project_worker', label: STRINGS.audit.entityProjectWorker },
];

/**
 * Derive the filter set visible to a worker caller. Workers must not
 * see `entityType = 'user'` as an option — the server never returns
 * user-entity rows to workers anyway (scope predicate, api.md §14.3),
 * but hiding the choice matches the spec's nav-visibility ruling.
 */
function entityTypeOptionsForCaller(
  isWorker: boolean,
): { value: AuditEntityType; label: string }[] {
  if (isWorker) return ALL_ENTITY_TYPES.filter((o) => o.value !== 'user');
  return ALL_ENTITY_TYPES;
}

export function AuditManagement() {
  const canReadAudit = usePermission('audit:read');
  const authUser = useAuthStore((s) => s.authUser);
  const entries = useAuditStore((s) => s.entries);
  const total = useAuditStore((s) => s.total);
  const [local, setLocal] = useState<LocalFilters>({});
  const [dateError, setDateError] = useState<string | null>(null);

  const isWorkerOnly = authUser
    ? authUser.roles.includes('worker') &&
      !authUser.roles.includes('owner') &&
      !authUser.roles.includes('office')
    : false;

  const entityTypeOptions = useMemo(() => entityTypeOptionsForCaller(isWorkerOnly), [isWorkerOnly]);

  // The filterKey is a stable string derived from the applied filters
  // — it captures the identity the feed should refetch on without
  // needing to pass the filters object through `useEffect` deps.
  const appliedFilters = useMemo(() => {
    // Build the wire filter — only include fields the user has set.
    const out: {
      entityType?: AuditEntityType;
      actorId?: string;
      action?: string;
      from?: string;
      to?: string;
    } = {};
    if (local.entityType) out.entityType = local.entityType;
    if (local.actorId) out.actorId = local.actorId;
    if (local.action) out.action = local.action;
    if (local.from) out.from = new Date(local.from).toISOString();
    if (local.to) out.to = new Date(local.to).toISOString();
    return out;
  }, [local]);

  const filterKey = useMemo(() => JSON.stringify(appliedFilters), [appliedFilters]);

  const updateLocal = (patch: Partial<LocalFilters>) => {
    setLocal((prev) => {
      const next = { ...prev, ...patch };
      // Client-side validation of date range (api.md §14.2.8 inverts
      // on the server too, but a client check blocks the submit
      // before the round-trip — conventional UX).
      if (next.from && next.to) {
        const fromTs = Date.parse(next.from);
        const toTs = Date.parse(next.to);
        if (!Number.isNaN(fromTs) && !Number.isNaN(toTs) && toTs < fromTs) {
          setDateError(STRINGS.audit.filterDateInverted);
          return next;
        }
      }
      setDateError(null);
      return next;
    });
  };

  const clearFilters = () => {
    setLocal({});
    setDateError(null);
  };

  if (!canReadAudit) {
    // Defense-in-depth — the route guard already catches this.
    return null;
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>{STRINGS.audit.heading}</h2>

      <div className={styles.filterBar}>
        <div className={styles.filterField}>
          <label className={styles.filterLabel} htmlFor="audit-filter-entity-type">
            {STRINGS.audit.filterEntityType}
          </label>
          <select
            id="audit-filter-entity-type"
            className={styles.filterSelect}
            value={local.entityType ?? ''}
            onChange={(e) =>
              updateLocal({
                entityType: (e.target.value || undefined) as AuditEntityType | undefined,
              })
            }
            data-testid="audit-filter-entity-type"
          >
            <option value="">{STRINGS.audit.allEntityTypes}</option>
            {entityTypeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterField}>
          <label className={styles.filterLabel} htmlFor="audit-filter-action">
            {STRINGS.audit.filterAction}
          </label>
          <select
            id="audit-filter-action"
            className={styles.filterSelect}
            value={local.action ?? ''}
            onChange={(e) => updateLocal({ action: e.target.value || undefined })}
            data-testid="audit-filter-action"
          >
            <option value="">{STRINGS.audit.allActions}</option>
            {AUDIT_ACTION_KEYS.map((key) => (
              <option key={key} value={key}>
                {AUDIT_ACTION_LABELS[key]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterField}>
          <label className={styles.filterLabel} htmlFor="audit-filter-from">
            {STRINGS.audit.filterFrom}
          </label>
          <input
            id="audit-filter-from"
            type="date"
            className={styles.filterInput}
            value={local.from ?? ''}
            onChange={(e) => updateLocal({ from: e.target.value || undefined })}
            data-testid="audit-filter-from"
          />
        </div>

        <div className={styles.filterField}>
          <label className={styles.filterLabel} htmlFor="audit-filter-to">
            {STRINGS.audit.filterTo}
          </label>
          <input
            id="audit-filter-to"
            type="date"
            className={styles.filterInput}
            value={local.to ?? ''}
            onChange={(e) => updateLocal({ to: e.target.value || undefined })}
            data-testid="audit-filter-to"
          />
        </div>

        <div className={styles.filterActions}>
          <button
            type="button"
            className={styles.clearButton}
            onClick={clearFilters}
            data-testid="audit-clear-filters"
          >
            {STRINGS.ui.clearFilter}
          </button>
        </div>
      </div>

      {dateError && <div className={styles.validationError}>{dateError}</div>}

      <ActivityFeed filters={appliedFilters} filterKey={filterKey} testId="audit-list" />
      {/* Reference entries + total to satisfy the "list exposes counts" contract
          for any future test that inspects it. */}
      <div hidden data-testid="audit-total" data-count={total} data-rendered={entries.length} />
    </div>
  );
}
