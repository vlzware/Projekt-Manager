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
 *
 * Actor-filter visibility: the dropdown form requires `user:read` so
 * actor display names can be rendered (owner / office under the default
 * matrix). Callers without `user:read` see a UUID text input —
 * practical only for callers with an out-of-band id, but present for
 * completeness. Workers lack `user:read` and, per the nav matrix, the
 * actor-filter is effectively useless for them; the UI still shows
 * the input rather than removing it, so the filter bar's shape is
 * invariant across roles.
 */

import { useEffect, useMemo, useState } from 'react';
import { usePermission } from '@/hooks/usePermission';
import { useAuthStore } from '@/state/authStore';
import { useUserStore } from '@/state/userStore';
import { STRINGS } from '@/config/strings';
import type { AuditEntityType, AuditListParams } from '@/domain/audit';
import { ActivityFeed } from './ActivityFeed';
import { AuditFilterBar, type LocalFilters } from './AuditFilterBar';
import styles from './AuditManagement.module.css';

const ALL_ENTITY_TYPES: { value: AuditEntityType; label: string }[] = [
  { value: 'project', label: STRINGS.audit.entityProject },
  { value: 'customer', label: STRINGS.audit.entityCustomer },
  { value: 'user', label: STRINGS.audit.entityUser },
  { value: 'project_worker', label: STRINGS.audit.entityProjectWorker },
];

/**
 * RFC 4122 UUID-like shape check. Matches the canonical 8-4-4-4-12 hex
 * form; case-insensitive. Strict enough to catch typos before the
 * round-trip; loose enough that it doesn't re-enforce version/variant
 * bits that the server already validates at the `format: 'uuid'` JSON
 * schema layer. The server is authoritative — this is UX feedback.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_SHAPE.test(value);
}

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

/**
 * Convert a local `<input type="date">` value (`YYYY-MM-DD`) into an
 * ISO-8601 string representing the start or end of that day in the
 * user's local timezone.
 *
 * Why not `new Date('2026-04-20').toISOString()`? That constructor
 * treats the bare date as UTC midnight. For a user in Europe/Berlin,
 * the `from` filter would lose two hours of the intended day and the
 * `to` filter would only cover the first two hours — the user asks
 * "show me today's activity" and the server answers "sure, but only
 * the last 22 hours of yesterday." Appending `T00:00:00` (no `Z`)
 * makes the parser treat the value as local time; `Date.prototype.
 * toISOString()` then normalizes to UTC for the wire.
 */
function localStartOfDayIso(dateInput: string): string {
  return new Date(`${dateInput}T00:00:00`).toISOString();
}

function localEndOfDayIso(dateInput: string): string {
  // `.999` milliseconds so the upper bound is inclusive to the last
  // millisecond of the user's local day. The server treats the `to`
  // bound as `<=`; an equivalent formulation is "start of next day,
  // exclusive", which would need cross-month arithmetic client-side
  // and is no more correct than this form.
  return new Date(`${dateInput}T23:59:59.999`).toISOString();
}

export function AuditManagement() {
  const canReadAudit = usePermission('audit:read');
  const canReadUsers = usePermission('user:read');
  const authUser = useAuthStore((s) => s.authUser);
  const users = useUserStore((s) => s.users);
  const fetchUsers = useUserStore((s) => s.fetchUsers);
  const [local, setLocal] = useState<LocalFilters>({});
  const [dateError, setDateError] = useState<string | null>(null);
  const [entityIdError, setEntityIdError] = useState<string | null>(null);
  const [actorIdError, setActorIdError] = useState<string | null>(null);

  const isWorkerOnly = authUser
    ? authUser.roles.includes('worker') &&
      !authUser.roles.includes('owner') &&
      !authUser.roles.includes('office')
    : false;

  const entityTypeOptions = useMemo(() => entityTypeOptionsForCaller(isWorkerOnly), [isWorkerOnly]);

  // Load the user list once for the actor dropdown. Callers without
  // `user:read` skip this — the actor filter falls back to a free-text
  // UUID input for them.
  useEffect(() => {
    if (!canReadAudit || !canReadUsers) return;
    if (users.length === 0) {
      void fetchUsers();
    }
    // users.length is intentionally NOT in the deps — a server list of
    // zero users would loop. "List already attempted" is acceptable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReadAudit, canReadUsers, fetchUsers]);

  // Compute the applied filter — only include fields that are (a) set
  // and (b) pass shape validation. An invalid UUID in entityId or
  // actorId is surfaced via the validation error and NOT sent to the
  // server.
  const appliedFilters = useMemo<AuditListParams>(() => {
    const out: AuditListParams = {};
    if (local.entityType) out.entityType = local.entityType;
    if (local.entityId && isValidUuid(local.entityId)) out.entityId = local.entityId;
    if (local.actorId && isValidUuid(local.actorId)) out.actorId = local.actorId;
    if (local.action) out.action = local.action;
    if (local.from) out.from = localStartOfDayIso(local.from);
    if (local.to) out.to = localEndOfDayIso(local.to);
    return out;
  }, [local]);

  const filterKey = useMemo(() => JSON.stringify(appliedFilters), [appliedFilters]);

  const updateLocal = (patch: Partial<LocalFilters>) => {
    setLocal((prev) => {
      const next = { ...prev, ...patch };
      // Date-range validation (api.md §14.2.8 inverts on the server
      // too, but a client check blocks the submit before the round-trip).
      if (next.from && next.to) {
        const fromTs = Date.parse(next.from);
        const toTs = Date.parse(next.to);
        if (!Number.isNaN(fromTs) && !Number.isNaN(toTs) && toTs < fromTs) {
          setDateError(STRINGS.audit.filterDateInverted);
          return next;
        }
      }
      setDateError(null);
      // UUID shape validation — run against the next patch only if the
      // field was actually touched by this update, otherwise keep the
      // existing error/no-error state untouched (avoids clearing a
      // previous error when the user types in a different field).
      if ('entityId' in patch) {
        if (next.entityId && !isValidUuid(next.entityId)) {
          setEntityIdError(STRINGS.validation.mustBeUuid(STRINGS.audit.filterEntityId));
        } else {
          setEntityIdError(null);
        }
      }
      if ('actorId' in patch) {
        if (next.actorId && !isValidUuid(next.actorId)) {
          setActorIdError(STRINGS.validation.mustBeUuid(STRINGS.audit.filterActor));
        } else {
          setActorIdError(null);
        }
      }
      return next;
    });
  };

  const clearFilters = () => {
    setLocal({});
    setDateError(null);
    setEntityIdError(null);
    setActorIdError(null);
  };

  if (!canReadAudit) {
    // Defense-in-depth — the route guard already catches this.
    return null;
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>{STRINGS.audit.heading}</h2>

      <AuditFilterBar
        local={local}
        entityTypeOptions={entityTypeOptions}
        users={users}
        canReadUsers={canReadUsers}
        entityIdHasError={!!entityIdError}
        actorIdHasError={!!actorIdError}
        onChange={updateLocal}
        onClear={clearFilters}
      />

      {dateError && <div className={styles.validationError}>{dateError}</div>}
      {entityIdError && <div className={styles.validationError}>{entityIdError}</div>}
      {actorIdError && <div className={styles.validationError}>{actorIdError}</div>}

      <ActivityFeed
        filters={appliedFilters}
        filterKey={filterKey}
        testId="audit-list"
        layout="table"
      />
    </div>
  );
}
