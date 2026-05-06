# Data Model

---

## 5. Data Model

### 5.1 Project Entity

The entity is stored in the database. Two audit fields (`createdBy`, `updatedBy`) track the acting user.

```typescript
// Derived from the workflow state configuration — see §3 in index.md.
type WorkflowState =
  | 'anfrage'
  | 'angebot'
  | 'beauftragt'
  | 'geplant'
  | 'in_arbeit'
  | 'abnahme'
  | 'rechnung_faellig'
  | 'abgerechnet'
  | 'erledigt';

interface Project {
  id: string; // UUID
  number: string; // "2026-042" — year + sequential [C]
  title: string; // "Fassadenanstrich Müller"
  status: WorkflowState;
  statusChangedAt: string; // ISO 8601 — for aging calculations

  customerId: string; // references Customer.id (§5.6)

  plannedStart?: string; // ISO 8601 date
  plannedEnd?: string; // ISO 8601 date

  assignedWorkers?: { userId: string; displayName: string }[]; // references UserAccount (m:n join, see §6.6)
  estimatedValue?: number; // EUR net
  notes?: string;

  deleted: boolean; // soft-delete flag — excluded from queries when true

  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  createdBy?: string; // UserAccount.id — optional: seeded/imported records may lack a known actor
  updatedBy?: string; // UserAccount.id — optional: seeded/imported records may lack a known actor
}
```

Design notes:

- `statusChangedAt` is separate from `updatedAt` — editing notes must not reset aging calculations.
- `customerId` references Customer (§5.6). The API nests the full customer object in responses; writes accept `customerId`.
- `assignedWorkers` is m:n via a join table. API returns `{ userId, displayName }`; writes accept `assignedWorkerIds: string[]`.
- `WorkflowState` reflects the default configuration. The type is derived from the configuration array (see [index.md §3](index.md#3-workflow-states)).
- Warnings and aging are derived from state and timestamps at render time — not stored.

### 5.2 State Metadata

```typescript
type StateType = 'action' | 'buffer' | 'active' | 'done';

interface StateConfig {
  key: WorkflowState;
  label: string; // German display label
  type: StateType;
  order: number; // position in workflow sequence (1-9)
  color: string; // hex color
  agingThresholdDays?: number; // days before aging indicator appears [C]
  agingBoldDays?: number; // days before date display turns bold [C]
  collapseTier: 1 | 2 | 3; // responsive collapse priority (1 = last to collapse) [C]
}
```

This configuration drives Kanban column rendering, color coding, and aging indicators from a single source.

**Aging field mapping by state type:**

| State type | `agingBoldDays`                    | `agingThresholdDays` | Visual effect                                                                   |
| ---------- | ---------------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| Action     | Used                               | Ignored              | Entry date turns **bold** after threshold                                       |
| Buffer     | Used (equals `agingThresholdDays`) | Used                 | Entry date turns **bold** at the same threshold + `"seit X Tagen"` text appears |
| Active     | Ignored                            | Ignored              | No aging behavior                                                               |
| Done       | Ignored                            | Ignored              | No aging behavior                                                               |

### 5.3 User Entity

```typescript
type AccountRole = string; // internal key — e.g. 'owner', 'office', 'worker', 'bookkeeper' [C]

type ThemePreference = 'light' | 'dark' | 'system';

interface UserAccount {
  id: string; // UUID
  username: string; // unique, used for login
  displayName: string; // shown in UI, e.g. "Maria Schmidt"
  passwordHash: string; // server/DB only — NEVER in API responses or client-side code
  roles: AccountRole[]; // array — see design notes
  email?: string;
  active: boolean; // soft-disable without deletion
  themePreference: ThemePreference; // default 'system' — see §5.7
  pushMuted: boolean; // default false — mutes push delivery only; activity-feed inclusion unaffected (§5.12)
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  lastLoginAt?: string; // ISO 8601
  createdBy?: string; // UserAccount.id — optional for seeded/bootstrapped records
  updatedBy?: string; // UserAccount.id — optional for seeded/bootstrapped records
}
```

Design notes:

- `createdBy` / `updatedBy` are nullable UUIDs with no FK constraint (bootstrapping the first admin would create a circular dependency).
- `roles` is an array — supports multi-role assignment without schema changes. Role set is configurable **[C]**. Role labels are applied by configuration.
- `passwordHash` is **never** included in API responses.
- `themePreference` controls the rendered color scheme per user (see [§5.7](#57-user-theme-preference)). The value must be one of the allowed literals; the database enforces this via a CHECK constraint (defense in depth).
- `pushMuted` is a self-settable boolean alongside `themePreference`. Default `false`. Updated via the self-update API ([api.md §14.2.1](api.md#1421-authentication)). Subscription-level semantics: [§5.12](#512-push-subscription); rationale for a single boolean vs. per-event matrix: [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md).
- Users can be deactivated (`active = false`) or hard-deleted (owner only). See [§6.9](#69-soft-deletes).

### 5.4 Session

Minimal session model. Transport mechanism is an implementation decision (see [ADR-0005](../adr/0005-session-management-httponly-cookies.md)).

```typescript
interface Session {
  id: string; // opaque session identifier
  userId: string; // references UserAccount.id
  token: string; // cryptographically random lookup key — transport mechanism detail
  createdAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
}
```

Design note: The `token` field is a cryptographically random, opaque value delivered to the client. The delivery mechanism is defined in [ADR-0005](../adr/0005-session-management-httponly-cookies.md).

Session validation must verify that the referenced user is still active (`active = true`). If the user has been deactivated, the session is treated as invalid regardless of its `expiresAt`.

**Password-change session side effects:** when a user changes their own password, all **other** sessions for that user are invalidated (the current session survives). When an administrator resets another user's password, **all** sessions for the target user are invalidated.

### 5.5 Audit Metadata

All persisted entities follow a common audit metadata pattern:

```typescript
interface AuditMetadata {
  createdAt: string; // ISO 8601 — set on creation, never modified
  updatedAt: string; // ISO 8601 — set on every mutation
  createdBy?: string; // UserAccount.id — optional for seeded/imported records
  updatedBy?: string; // UserAccount.id — optional for seeded/imported records
}
```

Rules:

- `createdAt` and `updatedAt` are managed by the server. Clients never send these fields in mutations.
- User-triggered mutations must set `updatedBy` to the authenticated user's ID and update `updatedAt`.
- `createdBy` and `updatedBy` are optional because seeded, imported, or system-generated records may not have a known actor.
- This pattern applies to `Project`, `Customer`, and `UserAccount`. `Session` uses `createdAt` and `expiresAt` only (sessions are not user-editable).

### 5.6 Customer Entity

```typescript
interface Customer {
  id: string; // UUID
  name: string; // "Familie Müller"
  phone?: string; // "+49 221 1234567"
  email?: string; // "mueller@example.de"
  address?: {
    street: string; // "Hauptstr. 12"
    zip: string; // "51465"
    city: string; // "Bergisch Gladbach"
  };
  notes?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  createdBy?: string; // UserAccount.id
  updatedBy?: string; // UserAccount.id
}
```

Design notes:

- Address is an optional nested object within Customer.
- Follows the audit metadata pattern (§5.5).
- `name` is required; all other fields are optional.
- A customer may exist without any projects (e.g., imported from an external system before project creation).
- Customers can be hard-deleted via the API when no **active** (non-archived) projects reference them. Archived projects are purged atomically with the customer (see [§6.9](#69-soft-deletes) and [ADR-0017](../adr/0017-soft-delete-as-board-archive.md)). Deletion requires the `customer:delete` permission (owner only). A customer without projects is a normal state (e.g., imported before project creation) and deleting such a record is a cleanup operation, not a data-integrity concern.

### 5.7 User Theme Preference

`UserAccount.themePreference` is the server-authoritative source for the user's chosen color scheme.

| Value      | Effect                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `'light'`  | The UI renders the light theme regardless of operating-system scheme.                                   |
| `'dark'`   | The UI renders the dark theme regardless of operating-system scheme.                                    |
| `'system'` | The UI follows the operating system's color-scheme preference and updates when that preference changes. |

- New users default to `'system'`.
- The value is updated by the authenticated user via the self-update API operation (see [api.md §14.2.1](api.md#1421-authentication)).
- The server value is authoritative. Clients may cache the value locally to prevent a flash of the wrong theme on page load, but must replace any cached value with the server value on session hydration.

### 5.8 Export Envelope

The unified export and import surface ([api.md §14.2.4](api.md#1424-unified-data-exchange)) exchanges a single envelope carrying every row of the business-data layer. `schema_version` is `2`.

```typescript
interface ExportEnvelope {
  schema_version: 2; // monotonic integer; imports reject any mismatch
  exported_at: string; // ISO 8601 — informational only, not used for import semantics
  customers: Customer[]; // every row, all fields from §5.6
  projects: Project[]; // every row, all fields from §5.1, including archived (deleted = true)
  project_workers: { projectId: string; userId: string }[]; // every row of the join
  attachments: EnvelopeAttachment[]; // every row with status = 'ready' — metadata-only descriptor (see below)
}

interface EnvelopeAttachment {
  id: string; // UUID — preserved on restore via the `init` `restore` block (api.md §14.2.11)
  projectId: string;
  kind: 'photo' | 'binary';
  label: AttachmentLabel; // closed enum, §5.13
  fileName: string;
  mimeType: string; // plaintext MIME from the §5.13 whitelist
  sizeBytes: number; // plaintext byte count
  createdAt: string; // ISO 8601 — preserved on restore
  createdBy: string | null; // UserAccount.id reference — preserved on restore
}
```

Design notes:

- **Row-level fidelity for text rows.** Customers, projects, and project-worker assignments carry all persisted fields including `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, and `deleted`. Imports preserve IDs exactly (see [ADR-0018 §Decision](../adr/0018-data-persistence-and-recovery-layered-strategy.md#decision)).
- **Archived rows are included.** Projects with `deleted = true` round-trip with their archive state intact (see [§6.9](#69-soft-deletes)).
- **Users and sessions are not included.** Admin bootstrap ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)) handles fresh installs; seed-time loading of users uses a direct-DB helper, while seed-time business-data loading goes through the import code path (see [§7](#7-seed-data-specification)).
- **Attachments: metadata-only descriptor.** Only rows with `status = 'ready'` are exported; `pending` rows (uncommitted uploads) and `hidden` rows (in the Papierkorb pending lifecycle reap, see [§5.13](#513-attachment) state machine) are excluded. The envelope carries the per-row metadata fields needed to restore identity and reach the right project on import; it does NOT carry crypto fields (`wrappedDek`, `wrappedThumbDek`, `wrappedDekVersion`), opaque storage keys (`originalKey`, `thumbKey`), or ciphertext sizes (`ciphertextSizeBytes`, `ciphertextThumbSizeBytes`) — those are not consumable on the importing instance and were dead weight under the new shape. The wrapped envelopes were also load-bearing for confidentiality on the exporting instance and are deliberately kept off the takeout artifact.
- **Restore mechanics are client-driven.** Bytes live in object storage (Layer 3 per [ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md)) and ride alongside the envelope as plaintext entries inside the takeout zip ([ui/daten.md §8.11.1](ui/daten.md#8111-export)). On import, the browser orchestrator re-uploads each plaintext file through the existing `init` (with `restore` block) → presigned PUT → `complete` pipeline against the importing instance. Fresh DEKs are minted in the browser; the importing instance wraps them under its own `BINARY_AGE_RECIPIENT`. No key material crosses the takeout boundary; no plaintext bytes cross the importing instance's app server.
- **`schema_version` is monotonic.** Imports compare strictly and reject any mismatch — no format migration code. The current value is `2`.

### 5.9 Backup Status Entity

The Layer 2 backup-and-drill cycle ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)) publishes its last-run result into a single-row table so the application — and, via the status mirror object, an out-of-app reader — can render backup freshness without polling the scheduler.

```typescript
interface BackupStatus {
  lastBackupAt?: string; // ISO 8601 — timestamp of the last completed run (success or failure)
  lastBackupOk: boolean; // true when the last run produced an uploaded, Tier-1-verified artifact
  lastDrillAt?: string; // ISO 8601 — timestamp of the last Tier-2 drill attempt
  lastDrillOk: boolean | null; // true when the last Tier-2 drill succeeded; false when it failed; null before any Tier-2 drill has been attempted
  lastError?: string; // short machine-readable failure cue; null on success
  updatedAt: string; // ISO 8601 — set by the backup service on every write
}
```

Design notes:

- **Single row, denormalized by design.** Only the most recent result is observable; history lives in the off-site object store's object timestamps and in container logs. The row is created by migration and is never deleted.
- **Mutation semantics: upsert only.** The backup service writes via upsert on a fixed primary key; the application never mutates this row.
- **Dual-write mirror.** Every backup run writes this row AND an unencrypted status mirror object in the off-site object store with the same fields. The mirror exists so backup health is readable when the database is unreachable ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)).
- **`lastDrillOk` semantics.** `lastDrillOk` is `null` before any Tier 2 drill has succeeded OR failed. A null value is not equivalent to "skipped" — skipped runs leave both `lastDrillAt` and `lastDrillOk` unchanged from the previous run, so freshness is derived from `lastDrillAt` rather than coerced to a boolean.
- **Cross-references.** Freshness thresholds for the owner-only badge are defined under [architecture.md §12.2](architecture.md#122-company-configurable-settings); acceptance criteria in [verification.md §15.22](verification.md#1522-backup-and-recovery).

### 5.10 Audit Log Entity

An append-only record of every domain-entity state change. Drives the user-facing activity view ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed), [ui/management.md §8.13](ui/management.md#813-audit-view)) and the notification publisher. Rationale and the single-write-path contract live in [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md).

```typescript
type AuditActorKind = 'user' | 'system';

type AuditEntityType = 'project' | 'customer' | 'user' | 'project_worker' | 'attachment';

interface AuditLogEntry {
  id: string; // UUID
  createdAt: string; // ISO 8601 — set by the server at commit time
  actorId?: string; // references UserAccount.id — null when actorKind = 'system'
  actorKind: AuditActorKind; // 'user' for authenticated callers, 'system' for bootstrap and other unattended domain-entity writes
  actorReason?: string; // required (non-empty) when actorKind = 'system'; null for 'user' entries
  entityType: AuditEntityType; // the domain entity that changed
  entityId: string; // identifier of the affected row
  entityLabel?: string; // human-readable label captured at write time (see design notes)
  action: string; // vocabulary defined below — free text for forward compatibility
  payload: object; // JSON — before/after of changed fields only, not the full row
  correlationId?: string; // request-scoped id threaded from the route layer, where available
}
```

Design notes:

- **Append-only from the application.** The application never updates an `audit_log` row and never deletes one through any API, service, or UI path. The retention cleanup job ([§6.10](#610-audit-log-retention)) is the only path that removes rows and operates as infrastructure, not as a domain mutation — it does not itself produce an `audit_log` row.
- **Scope is domain-entity state changes.** `project`, `customer`, `user`, `project_worker`, and `attachment` are the audited types. Authentication and session events (login, logout, session reap) are security events and surface through the structured logger, not `audit_log` — per [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md).
- **Actor kind semantics.**
  - `user` — an authenticated caller performed the mutation. `actorId` references the `UserAccount.id`; `actorReason` is null.
  - `system` — no authenticated caller is present. `actorId` is null; `actorReason` is required and carries a human-readable cue naming the code path (e.g., `"first-run-bootstrap"`). First-run admin bootstrap ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)) is the current domain-entity system-actor path. A system entry with an empty or missing `actorReason` is rejected by the database via a CHECK constraint (defense in depth) — else a system write would be invisible in the activity feed.
- **Action vocabulary.** `action` is free text so new mutation shapes can record without a schema migration. The current vocabulary is `create`, `update`, `delete`, `archive`, `transition:forward`, `transition:backward`, `purge`, `reactivate`, `deactivate`, `password-reset`, `password-change`, `attachment:add`, `attachment:hide`, `attachment:restore`, `attachment:purge`. `archive` is the `entityType = 'project'` soft-delete action (see [ADR-0017](../adr/0017-soft-delete-as-board-archive.md)); `delete` and `purge` remain distinct (generic delete for non-project entities, hard-delete on projects respectively). `attachment:add`, `attachment:hide`, and `attachment:restore` live on `entityType = 'attachment'` and correspond to init, user-DELETE (soft-hide per [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)), and Papierkorb-restore respectively. `attachment:purge` records the system-initiated permanent destruction of a hidden attachment row by the hidden reaper ([§6.12](#612-attachment-hidden-reaper)) — distinct from `attachment:hide`, which is the user-initiated soft-hide that moves the row to the Papierkorb. The orphan reaper ([§6.11](#611-attachment-orphan-reaper)) removes rows / objects without producing audit rows — it operates on housekeeping artifacts that never entered the user-visible domain. A free-text field is chosen over an enum because the vocabulary is expected to grow with new features and an enum would churn the schema; uniqueness and casing are enforced by convention and reviewed at PR time. Each entry in the vocabulary maps to exactly one mutation shape.
- **Payload shape.** `payload` carries the changed fields only, as `{ before, after }` field-keyed objects — not the full row. For a create, `before` is empty and `after` carries the persisted values for every non-server-managed field. For a delete or purge, `after` is empty. For a state transition, `before` and `after` carry `status` and `statusChangedAt`. Full-row snapshots are deliberately excluded (see [ADR-0021 — Alternatives Considered](../adr/0021-audit-log-and-notifications-single-write-path.md#alternatives-considered)).
- **Entity label snapshot.** `entityLabel` is a nullable text column captured at write time (e.g. a project's `"2026-002 Innenraumgestaltung Weber"`, a customer's `"Firma Weber GmbH"`, a user's `displayName`). Frozen with the audit row so the activity feed stays readable after the target is renamed or purged. Write paths that do not have a natural label (import, retention cleanup) leave it null; the UI falls back to `entityId`. This is display metadata — it is not part of the `{ before, after }` diff contract. For `project_worker` rows specifically, `entityId` is the project's id (not the join-row's composite key) and `entityLabel` is the **worker's** displayName — the feed reads "Jan Nowak wurde zugewiesen" under the owning project's header, so the worker name is the meaningful label, while the project id remains the row's target. Pinned by [AC-188](verification.md#1523-audit-log).
- **Correlation id.** `correlationId` is a nullable, per-request id set at the route layer and threaded through the service call chain. It groups every audit row produced by one request, enabling a future bulk-undo or one-request trace. Null is valid for entries produced outside a request (bootstrap and other unattended domain-entity writes).
- **Referential integrity.** `actorId` is a nullable foreign key to `UserAccount.id`; when a user is hard-deleted, `actorId` is set to null rather than cascading the audit row (parity with [AC-98](verification.md#1517-data-integrity)). `entityId` is not foreign-keyed — a purge removes the target row while its audit trail remains.
- **Transactional write.** Every domain-entity mutation and its audit row commit in a single database transaction. The application does not write the state change without the audit row, and it does not write the audit row without the state change. See [architecture.md §11.3](architecture.md#113-state-layer-behavioral-contract) and [ADR-0021 — Decision](../adr/0021-audit-log-and-notifications-single-write-path.md#decision).
- **Non-audited self-preference writes on `UserAccount`.** A narrow carve-out from the single-write-path invariant: a self-update API call ([api.md §14.2.1](api.md#1421-authentication)) whose patch touches only `themePreference`, `pushMuted`, or both writes the new values without producing an `audit_log` row. These are per-user UI/notification preferences with no cross-user or security consequence; auditing them would add rows to the activity feed that are not "who-did-what-to-whom" events and would drown out the actor-on-entity traffic the feed is optimized for (ADR-0021 "high-signal activity feed"). Any write that touches `roles`, `active`, `username`, `displayName`, `email`, or `passwordHash` (administrator paths, not self-update) goes through `mutate()` and produces an audit row unconditionally. The CI architecture check ([verification.md AC-179](verification.md#1523-audit-log)) remains authoritative for every non-carve-out mutation on `user_accounts`; the carve-out is expressed as an allowlisted write site, not a general bypass of the single-write-path helper.
- **Post-commit notification dispatch.** Subscribers (notification publisher and any future projection) dispatch after the transaction commits, so a throwing subscriber cannot roll back domain state. The `audit_log` row is the event source; publishing is a read-over-audit projection.

### 5.11 Notification Rule

Admin-editable configuration mapping a closed event catalog to recipient specs. Rule writes are direct repository writes; rule configuration is not surfaced on the activity feed. Rationale and alternatives: [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md).

```typescript
type NotificationEventClass =
  | 'project.transition_forward'
  | 'project.transition_backward'
  | 'project.archived'
  | 'project.assignment_changed'
  | 'backup.failed'
  | 'disk.threshold_reached';

interface NotificationRecipientSpec {
  roles: AccountRole[]; // additive — every user holding any of these roles
  includeAssignedWorkers: boolean; // additive — only meaningful for project-scoped events
  userIds: string[]; // additive — UserAccount.id values
}

interface NotificationRule {
  id: string; // UUID
  eventClass: NotificationEventClass;
  stateFilter?: WorkflowState | null; // only meaningful for transition events; null = no filter
  recipientSpec: NotificationRecipientSpec;
  enabled: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  createdBy?: string; // UserAccount.id
  updatedBy?: string; // UserAccount.id
}
```

Design notes:

- **Closed event catalog.** `NotificationEventClass` is the shipping set. Adding a class is a code change plus a migration ([ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)); users never author event classes. Upload-milestone classes ship with the upload-milestone surface.
- **Event source mapping.** `project.transition_forward` / `project.transition_backward` → `entityType = 'project'` AND `action = 'transition:forward' | 'transition:backward'`. `project.archived` → `entityType = 'project'` AND `action = 'archive'` (soft-delete = archive — distinct from `purge` (hard-delete) and the generic `delete` used for other entity types, see [ADR-0017](../adr/0017-soft-delete-as-board-archive.md)). `project.assignment_changed` → `entityType = 'project_worker'` with `action` in `create` or `delete`. `backup.failed` and `disk.threshold_reached` are non-mutation system events — they publish to the in-process bus without an `audit_log` row, per [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md).
- **`stateFilter` semantics.** Non-null only on the two transition event classes. Matches when `after.status` equals the filter; null means match regardless of target state. A non-null filter on a non-transition class is rejected at validation time.
- **`recipientSpec` is additive.** `roles`, `includeAssignedWorkers`, and `userIds` are unioned. An empty spec is rejected at validation so an enabled rule always has a non-empty candidate set before dedup.
- **`includeAssignedWorkers` scope.** Only meaningful when the event carries a `projectId` (`project.transition_*`, `project.archived`, `project.assignment_changed`). Rejected at validation for `backup.failed` and `disk.threshold_reached`.
- **No templates in the model.** Per-event German message templates are code-owned in the config layer. See [ADR-0023 Alternatives](../adr/0023-notification-rules-db-stored-closed-event-catalog.md#full-freeform-predicate-dsl-with-user-editable-message-templates).
- **No priority / no override.** Multiple matches produce a recipient **union**, deduplicated by `UserAccount.id`. No priority field, override flag, or AND/OR tree — see [ADR-0023 Alternatives](../adr/0023-notification-rules-db-stored-closed-event-catalog.md#rule-matching-with-priority--override--and-or-trees).
- **Invalid-recipient resilience.** A resolved recipient whose `UserAccount` is missing or `active = false` is skipped at dispatch; remaining recipients proceed. Zero live recipients completes without error.
- **Rule take-effect.** A rule change affects the next event committed after the change; in-flight events use the rule set read at their own commit.
- **Configuration layering.** Each `NotificationEventClass`'s German activity-feed description lives in the `[C]` catalogue ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) under the audit activity-feed rendering entry — already keyed on `(action, payload)`, the per-event identity the publisher emits.

### 5.12 Push Subscription

Per-device push subscription. A user may register multiple devices (phone, desktop); unsubscribing one does not affect the others.

```typescript
interface PushSubscription {
  id: string; // UUID
  userId: string; // references UserAccount.id (ON DELETE CASCADE)
  endpoint: string; // opaque browser-provided endpoint — unique within a user
  p256dh: string; // opaque key material delivered by the browser push API
  auth: string; // opaque key material delivered by the browser push API
  userAgent?: string; // nullable — captured at subscribe time so the user can identify a device in their subscription list
  createdAt: string; // ISO 8601
}
```

Design notes:

- **Per-device identity.** `endpoint` is unique within a user (`(userId, endpoint)` uniqueness); re-subscribing an existing endpoint updates the row. Rows are deleted either by the server on a permanent-error dispatch or by the user via unsubscribe.
- **Ownership.** `userId` is set from the authenticated caller at subscribe time; a caller-supplied user id is ignored.
- **Denormalized key material.** `p256dh` and `auth` are the two opaque tokens the browser push API returns at subscribe time. They are stored as two named text fields rather than a single JSONB blob so the dispatcher reads them directly without an additional unpacking step. The field names `p256dh` and `auth` are the browser push API's own externally-defined names — not implementation details — and round-trip verbatim between the client, the server, and the push service. Neither field is ever rendered in the UI.
- **Mute interaction.** When the owner's `pushMuted` is `true`, the dispatcher skips every subscription they own. Rows are retained — mute is a delivery-time filter, so unmuting restores delivery without a re-subscribe.
- **User deactivation / deletion.** Deactivation (`active = false`) suspends dispatch to the user's subscriptions. Hard-delete cascades `push_subscription` rows (parity with session cleanup; see [§6.9](#69-soft-deletes)).
- **No retention window.** Rows live until unsubscribed or cascaded by user deletion; stale endpoints are pruned at dispatch time via permanent-error handling. There is no elapsed-time garbage collection — rows are removed only by unsubscribe, user cascade, or a permanent dispatch error (e.g., a gone-endpoint response from the push service).

### 5.13 Attachment

A file attached to a project. Metadata lives in the database (Layer 1 business data, round-trips with [§5.8](#58-export-envelope)); the bytes themselves live in object storage (Layer 3, [ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md)).

```typescript
type AttachmentLabel =
  | 'angebot'
  | 'auftragsbestaetigung'
  | 'rechnung'
  | 'aufmass'
  | 'foto'
  | 'sonstiges';

type AttachmentKind = 'photo' | 'binary';

type AttachmentStatus = 'pending' | 'ready' | 'hidden';

interface Attachment {
  id: string; // UUID
  projectId: string; // references Project.id (ON DELETE CASCADE)
  status: AttachmentStatus; // 'pending' after init; 'ready' after complete + HEAD; 'hidden' after user-DELETE
  label: AttachmentLabel; // closed set — see below
  kind: AttachmentKind; // 'photo' for image types rendered in the gallery; 'binary' otherwise
  fileName: string; // client-supplied display name; sanitized — see design note "Filename sanitization"
  mimeType: string; // plaintext MIME from the whitelist — see below; storage objects carry a sentinel `application/octet-stream` per [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)
  sizeBytes: number; // plaintext size of the original; backs the per-file cap check at init and rides the export envelope
  thumbSizeBytes?: number; // plaintext size of the thumbnail; null for non-photo kinds
  ciphertextSizeBytes: number; // size of the encrypted original object as returned by HEAD; verified at complete
  ciphertextThumbSizeBytes?: number; // size of the encrypted thumbnail object as returned by HEAD; null for non-photo kinds
  originalKey: string; // opaque storage key for the encrypted original object
  thumbKey?: string; // opaque storage key for the encrypted thumbnail; null for non-photo kinds
  wrappedDek: string; // base64 of the age-wrapped envelope of the per-blob 32-byte AES-256-GCM DEK for the original; opaque bytes; schema-level audit-excluded (see design notes)
  wrappedThumbDek?: string; // base64 of the age-wrapped envelope of the per-blob DEK for the thumbnail; null for non-photo kinds; schema-level audit-excluded
  wrappedDekVersion: number; // monotonic envelope-format discriminator shared by both wrapped envelopes on this row; current value 1 (age X25519 KEM + ChaCha20-Poly1305); unwrap path validates and refuses unknown values ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md))
  versionId?: string; // S3 version-id of the original at the moment status flipped to 'ready'; restore source
  thumbVersionId?: string; // S3 version-id of the thumb at complete time; null when no thumbnail
  hiddenAt?: string; // ISO 8601 — set when status flips to 'hidden'; null otherwise
  createdAt: string; // ISO 8601
  createdBy?: string; // UserAccount.id — set from the session at init time
}
```

Design notes:

- **State machine.** `pending → ready → hidden → ready` (restore re-flips to `ready`).
  - `pending` on successful init (row + presigned-PUT URLs issued, one per blob; the server has already wrapped the client-supplied DEK material into `wrappedDek` / `wrappedThumbDek` and persisted it on the row).
  - `ready` after the complete call verifies both objects exist via HEAD against object storage; HEAD asserts ciphertext metadata (size against `ciphertextSizeBytes` / `ciphertextThumbSizeBytes` and the sentinel content-type per [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)). `versionId` and (for photos) `thumbVersionId` are captured from the HEAD response at this moment.
  - `hidden` after a user-DELETE (soft-hide per [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)): the row stays, `hiddenAt` is set, and a delete marker is written on the versioned bucket so the prior version is preserved.
  - Restore from `hidden` re-flips to `ready` via `copyFromVersion` from the persisted `versionId` / `thumbVersionId`; the freshly-issued current-version ids replace the old pair. The wrapped-envelope columns are unchanged on restore — the DEK that decrypts the bytes is the same DEK that encrypted them.
  - A failed HEAD leaves the row at `pending`; the orphan reaper ([§6.11](#611-attachment-orphan-reaper)) is the only path that removes a stuck `pending` row.
- **Label is a closed set** — no free text, no per-deployment labels. German display labels are applied via configuration **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)). Rationale: closed-catalog pattern mirrors [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md) — labels are referenced by UI and filtering code; a user-authored taxonomy drifts.
- **Kind is derived from `mimeType` at init time.** `image/jpeg`, `image/png`, `image/webp` → `'photo'`. `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` → `'binary'`. Other types are rejected at init with a German message naming the supported set.
- **MIME whitelist** — exactly: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Values outside the set are rejected at init. HEIC (`image/heic`) is deliberately not on the list — the kickoff scope excludes Apple users and the transcode complexity does not earn its keep against that user base; clients receive a validation message pointing at the supported formats. `mimeType` is the **plaintext** MIME — it backs the download `Content-Disposition` header and the `kind` derivation. Storage objects carry a fixed sentinel content-type (`application/octet-stream`) per [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md); the row's `mimeType` is never overwritten with the sentinel.
- **Size cap** — `sizeBytes` (plaintext) must not exceed the configured per-file cap **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)). The cap is checked at init against the plaintext figure; `ciphertextSizeBytes` is what the presigned PUT is signed against and what HEAD asserts at complete.
- **DEK provenance.** The 32-byte AES-256-GCM data-encryption key is generated in the browser via `crypto.getRandomValues(new Uint8Array(32))` per attachment, fresh and single-use, before init. The init call carries the DEK material; the server wraps it once with the operator's binary `age` recipient and persists the envelope as `wrappedDek` (and, for photos, `wrappedThumbDek`) alongside `wrappedDekVersion = 1` (the format discriminator — see Wrapped envelope format below). The unwrapped DEK is never persisted server-side. Rationale and the rejected server-DEK alternative: [ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md).
- **Wrapped envelope format.** `wrappedDekVersion` is a monotonic, NOT NULL `smallint` shared between `wrappedDek` and `wrappedThumbDek` on a row (both envelopes are written at the same init and so share the same format). Current value is `1` (age X25519 KEM + ChaCha20-Poly1305). The unwrap path validates `version === 1` and throws on any other value (`envelope format unknown: <N>`). The discriminator is row-local — it does NOT ride the export envelope ([§5.8](#58-export-envelope)); each restored row gets a fresh DEK + fresh wrap stamped with the importing instance's current `wrappedDekVersion` via the standard upload pipeline. The column has no DB DEFAULT — every insert site sets the value explicitly so a future v2 introduction is a code change at the relevant init paths, not a silent column default flip ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)).
- **Wrapped envelope is server-handed-back.** At download / render the server unwraps the envelope per request and hands the DEK back to a same-origin Service Worker via the dedicated DEK fetch surface ([ADR-0024](../adr/0024-binary-attachment-e2e-encryption.md)). The wrapped-envelope columns themselves are never returned in any other API surface — not in attachment listings, not in single-row reads, not in audit payloads.
- **Audit exclusion.** `wrappedDek` and `wrappedThumbDek` MUST NOT appear in any `audit_log` `payload` ([§5.10](#510-audit-log-entity)). The exclusion is a hard property of the columns, declared at the schema layer rather than enforced per call site, so a future column-rename or new audited mutation cannot leak the envelopes. The wrapped envelopes are the entire crypto perimeter on B2 ciphertext; an audit dump (DB-only adversary) must remain useless without the operator-loaded `age` identity. Mechanism (declarative column-tag) and the AC-pinned test live in ARCHITECTURE.md and verification.md respectively.
- **Filename sanitization.** `fileName` must be non-empty, at most 255 characters, with no control characters (`\x00`–`\x1F`, `\x7F`), no path separators (`/`, `\`), and no double-quote (`"`). The double-quote rule exists because `fileName` is interpolated into the storage `Content-Disposition: attachment; filename="…"` header on presigned-GET download responses — a stray quote would let a malicious uploader inject header content. The server rejects violating values at init with `422 VALIDATION_ERROR` and persists no row ([api.md §14.2.11](api.md#14211-attachments)).
- **Storage keys are opaque.** `originalKey` and `thumbKey` are emitted by the server at init time. Clients treat them as opaque — only the server issues them, and only the server maps them to a download URL (see [api.md §14.2.11](api.md#14211-attachments)).
- **Ownership.** `createdBy` is set from the session at init time; a client-supplied value is ignored. The single carve-out is the import-mode `restore` block on `init` ([api.md §14.2.11](api.md#14211-attachments)), which pins `id`, `createdBy`, and `createdAt` from the takeout envelope when the caller holds both `data:restore` and `attachment:write`.
- **Cascade on project hard-delete.** When a project is purged (hard-delete via [api.md §14.2.2](api.md#1422-projects)), all `attachment` rows cascade via FK; the server also issues a best-effort `hide` on the backing objects (delete markers on the versioned bucket — [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)) so lifecycle reaps them on schedule. Soft-delete (archive) leaves attachments intact.
- **Lifecycle effects on storage usage.** Every transition above (init pending, complete to ready, user-DELETE to hidden, restore to ready, orphan reaper deletes pending, hidden reaper deletes hidden, project purge cascade) updates the parent project's accumulated storage totals — the per-project four-bucket invariant defined in [§5.14](#514-project-storage-usage). The update is part of the same lifecycle event; no separate write path is observable to callers.
- **Referential integrity with the export envelope.** Attachment metadata rows round-trip with Layer 1 per [§5.8](#58-export-envelope); plaintext bytes ride alongside the envelope as zip entries in the takeout artifact and are re-uploaded by the browser orchestrator into the importing instance via the standard `init` (with `restore` block) + per-blob PUT + `complete` pipeline ([api.md §14.2.11](api.md#14211-attachments)). Fresh DEKs and fresh wraps are minted on the importing instance; no key material crosses the takeout boundary, and the exporting-instance wrapped envelopes are deliberately kept off the takeout artifact. A row whose backing objects are absent post-restore (orchestrator skipped a per-file failure) is excluded from the photo gallery and from `bulk-fetch` selection; the metadata row stays intact — the mismatch is an operational condition, not a schema error. The exact UI rendering (German label, muted placeholder, disabled download action) lives in the SSOT: see [ui/project-detail.md §8.15.7](ui/project-detail.md#8157-restored-rows-without-backing-bytes).

### 5.14 Project Storage Usage

Each project carries an accumulated, system-maintained view of the byte volume of its attachments. The view is derived state — every value is the sum of `attachment` row fields — and exists so the application can render storage usage as a constant-time read instead of an aggregate over the attachment table. The per-project endpoint and the global roll-up in [api.md §14.2.12](api.md#14212-storage-usage) are the surfaces over this view.

```typescript
interface ProjectStorageUsage {
  projectId: string; // references Project.id
  ready: {
    plaintext: number; // sum of sizeBytes + thumbSizeBytes (when present) over status = 'ready' rows
    ciphertext: number; // sum of ciphertextSizeBytes + ciphertextThumbSizeBytes (when present) over status = 'ready' rows
  };
  hidden: {
    plaintext: number; // sum of sizeBytes + thumbSizeBytes (when present) over status = 'hidden' rows
    ciphertext: number; // sum of ciphertextSizeBytes + ciphertextThumbSizeBytes (when present) over status = 'hidden' rows
  };
}
```

Design notes:

- **Buckets align with attachment status.** `ready` is the live working set (the bytes the user can currently see in the gallery / binary list); `hidden` is the Papierkorb pool — recoverable until the hidden reaper ([§6.12](#612-attachment-hidden-reaper)) consumes the row. `pending` rows are excluded by construction: their backing objects may not exist on object storage yet, and the orphan reaper ([§6.11](#611-attachment-orphan-reaper)) is the only path that finalizes their disposition. Adding pending bytes to a user-facing total would surface uncommitted uploads; adding them to an operator-facing total would tally bytes that may never have been written.
- **Two byte counts per bucket.** **Plaintext** sums each row's declared `sizeBytes` plus declared `thumbSizeBytes` when `hasThumbnail = true` — the user-facing "what I uploaded" total. **Ciphertext** sums declared `ciphertextSizeBytes` plus declared `ciphertextThumbSizeBytes` when `hasThumbnail = true` — the operator-facing "what is on object storage" total. A photo always contributes both an original and a thumbnail blob ([§5.13](#513-attachment)); a non-photo contributes only the original.
- **System-maintained invariant.** The four totals are an authoritative invariant of the system, kept in lockstep with attachment lifecycle events (init pending, complete to ready, user-DELETE to hidden, restore to ready, orphan reaper deletes pending, hidden reaper deletes hidden, project purge cascade). The maintenance is automatic — no caller writes the totals; no lifecycle path can advance without the matching update; no missed write site can drift the totals against the underlying rows. The mechanism that delivers this invariant is documented in [`ARCHITECTURE.md § Attachments Module`](../../ARCHITECTURE.md#attachments-module).
- **Project deletion removes the totals with the project.** Hard-deleting (purging) a project removes the project's storage-usage view alongside the project itself — the usage row does not survive the parent. Soft-delete (archive) is a board-only operation per [§6.9](#69-soft-deletes) and does not touch the row; an archived project retains its accumulated totals (its attachments still exist, see [§5.13](#513-attachment)) and is included in the global roll-up exposed by [api.md §14.2.12](api.md#14212-storage-usage).
- **Authoritative totals, not a cache.** There is no cache layer; reads return the live totals at the time of the read. Reconciliation of the totals against the underlying attachment aggregate is a separate operational concern and is the subject of follow-up work not in scope here.

---

## 6. Persistence Principles

The product specification defines persistence behavior, not a concrete database technology or schema.

### 6.1 Durability

- Project data must survive page reloads, browser restarts, and deployment restarts.
- The application must read and write data only through a backend/API boundary.

### 6.2 Entity Extraction

The persistence design must support extraction of additional entities without rewriting existing domain logic.

### 6.3 Record Identity

- Every persisted entity must have a stable, opaque ID.
- IDs must not encode workflow state, dates, or company-specific semantics.

### 6.4 Concurrency

Low write concurrency is assumed; the design tolerates multiple concurrent users.

- **State transitions** use optimistic concurrency control — a transition is rejected as a conflict if the project's status has moved since the client's last read (see [AC-94](verification.md#1517-data-integrity)). The client should refetch and present the new state.
- **Other mutations** (date updates, PATCH updates) use last-write-wins. Concurrent edits to the same record silently overwrite — acceptable at the assumed concurrency level.

### 6.5 Schema Evolution

- The persistence layer must support schema evolution via versioned migrations. The database can be created from scratch by running all migrations in order.
- No manual database resets as the primary upgrade strategy.
- Migrations are versioned and reproducible.
- Seed data is separate from migrations — loaded by a distinct operation, not baked into migration files. This allows re-seeding or clearing seed data without re-running schema changes.

### 6.6 Referential Integrity

- The database enforces foreign keys where relationships exist (e.g., `Session.userId` references `UserAccount.id`, `Project.customerId` references `Customer.id`, `Project.createdBy`/`updatedBy` reference `UserAccount.id`).
- **Exception**: `UserAccount.createdBy`/`updatedBy` are nullable UUIDs with no FK constraint. A self-referential FK on the users table would complicate bootstrapping and deletion without adding meaningful integrity (see §5.3 design notes).
- Orphaned records are not acceptable.

### 6.7 Timestamps

Timestamp ownership rules are defined in section 5.5. Additionally, `statusChangedAt` is set by the server on state transitions, never by client input.

**Storage vs. API representation**: the database stores timestamps with timezone awareness. The API serializes them as ISO 8601 strings (e.g., `"2026-04-10T14:30:00.000Z"`). The client receives and sends ISO 8601 strings; the persistence layer handles conversion transparently. The spec uses `string` (ISO 8601) in entity type definitions to describe the API contract, not the storage type.

### 6.8 Date Validation

- If both `plannedStart` and `plannedEnd` are provided, `plannedEnd` must not be before `plannedStart`.
- Either date may be null (cleared). Setting only `plannedStart` without `plannedEnd` is valid (renders as single-day block in calendar).
- Setting only `plannedEnd` without `plannedStart` is not valid — the API rejects this combination, **and the database enforces the same invariant via a defense-in-depth CHECK constraint**. This guards direct DB writes (seed scripts, migrations, manual SQL) that bypass the route layer.
- The API rejects all invalid date combinations.

### 6.9 Soft Deletes

- Users can be deactivated (`active = false`) or hard-deleted. Deactivation is the default for preserving assignment history. Hard deletion is available to the owner role and cascades sessions and worker assignments; `createdBy`/`updatedBy` references are set to null. Self-deletion is rejected by the API.
- Projects are soft-deleted (`deleted = true`) as an **archive-from-board** mechanism (see [ADR-0017](../adr/0017-soft-delete-as-board-archive.md)). Archived projects are excluded from active views (Kanban, Calendar, list endpoints) but retained in the database as historical reference. This is not an audit trail — there is no immutability guarantee.
  - Archived projects are **immutable via the API**: transitions, date updates, PATCH, and re-delete are rejected as not found (see [AC-95](verification.md#1517-data-integrity)).
  - When a customer is deleted, their archived projects are **purged atomically** with the customer — the archive has no value without the customer relationship. Active (non-archived) projects still block customer deletion as a conflict (see [AC-92](verification.md#1511-customer-management)).
  - `project:purge` (owner-only) allows per-project hard-delete via `DELETE /api/projects/:id/purge`. Purge requires the project already be archived (`deleted = true`); the endpoint rejects with 409 Conflict otherwise. `project_workers` rows cascade via FK. See [AC-155](verification.md#1512-project-management) to [AC-158](verification.md#1512-project-management).
  - The API exposes an archived-project count on the customer GET response so the UI can warn before destructive customer deletion.
  - No restore path exists via the API. Recovery requires database access.

### 6.10 Audit Log Retention

- `audit_log` entries are retained for a rolling window of 90 days **[C]** (see [architecture.md §12.2](architecture.md#122-company-configurable-settings)), aligned with the Layer 2 backup window ([ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)) and the cross-surface retention choice recorded in [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md).
- A scheduled cleanup job removes entries older than the window. Removing entries via this job is the only delete path on the table; every other application path is append-only.
- Each cleanup run is itself recorded — not in `audit_log` (the scope is domain entities only, per [§5.10](#510-audit-log-entity)), but in the structured operational logger, tagged as a system event. Rationale: keeping retention out of `audit_log` preserves the "append-only from the application" invariant for callers reading the activity feed; retention visibility lives in operational logs alongside other scheduled-job outputs.
- **Operational-log contract.** Each run emits exactly one structured log line at `info` level with the following fields: `event = 'audit-retention-cleanup'` (fixed discriminator), `window_days` (integer — the configured retention window applied, from the `[C]` catalogue above), `removed_count` (non-negative integer — rows deleted in the run; `0` on a no-op run), `ran_at` (ISO 8601 timestamp of the run). An operator verifies retention by querying the operational log for `event = 'audit-retention-cleanup'`; the Aktivität UI ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed), [ui/management.md §8.13](ui/management.md#813-audit-view)) is _not_ the verification surface — it deliberately omits retention events to keep the domain-entity scope intact. The retention of the operational log line itself follows whatever operational-log retention the deployed environment enforces — this spec does not pin a separate retention for system log lines.
- Retention applies uniformly to all entity types; there is no per-entity-type override.

### 6.11 Attachment Orphan Reaper

- A scheduled job removes `attachment` rows stuck at `status = 'pending'` longer than the configured orphan-reaper TTL **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)). Rationale: the upload flow ([api.md §14.2.11](api.md#14211-attachments)) creates a `pending` row before the client uploads bytes; a client that aborts between init and complete leaves the row and any half-uploaded object behind.
- Each pending row the reaper removes is accompanied by a delete of its `originalKey` and (if set) its `thumbKey` in object storage. The row and the bytes are the two halves of the same garbage; leaving either behind reintroduces the orphan class.
- Each run emits exactly one structured operational log line at `info` level with fields `event = 'attachment-orphan-reaper'` (fixed discriminator), `ttl_minutes` (integer — the configured TTL applied, from the `[C]` catalogue above), `removed_count` (non-negative integer — rows deleted in the run; `0` on a no-op run), `ran_at` (ISO 8601 timestamp of the run). The run does not produce an `audit_log` row — attachments stuck at `pending` have never entered the domain (no `ready` ever observed), so removing them is housekeeping, not a domain event.
- A storage object deletion that fails (object already gone, provider transient error) is logged under the same event with `error_hint` populated; the row is still removed. The goal is to keep the metadata table clean; an object delete that finds nothing is a no-op, not a failure.
- An in-flight sweep is drained on graceful shutdown before the database pool closes — parity with the session reaper ([verification.md AC-132](verification.md#159-infrastructure)).

### 6.12 Attachment Hidden Reaper

- A scheduled job hard-DELETEs `attachment` rows with `status = 'hidden'` and `now() - hiddenAt > hidden-reaper TTL` **[C]** ([architecture.md §12.2](architecture.md#122-company-configurable-settings)). Rationale: a user-DELETE soft-hides the row (state machine in [§5.13](#513-attachment)) and the bucket lifecycle reaps the underlying noncurrent versions on the same window; without a row-side reaper the metadata accumulates indefinitely while the bytes are gone, leaving the Papierkorb listing referring to unrecoverable rows.
- The reaper's TTL equals the bucket hide-to-delete window `L` ([architecture.md §12.2](architecture.md#122-company-configurable-settings)) by construction. Decoupling them would create an unbounded window where the row is visible but the bytes are gone (the failure mode that motivates this section); aligning them bounds that window. The bucket lifecycle (provider-side, daily-ish) and the row reaper (app-side, `[C]`-interval) run on independent clocks, so a row may briefly outlive its bytes within one row-reaper interval after the cutoff. Restore against such a row returns `410 GONE` ([verification.md AC-234](verification.md#1526-attachments)); the row reaper closes the window on its next tick.
- Each removed row produces exactly one `audit_log` row, written through the single-write-path helper (`mutate()` per [§5.10](#510-audit-log-entity), [architecture.md §11.3](architecture.md#113-state-layer-behavioral-contract)), with `actorKind = 'system'`, `action = 'attachment:purge'`, `actorReason = 'hidden-reaper'`. `payload.before` carries the pre-purge row state per the payload-shape rules in [§5.10](#510-audit-log-entity); `payload.after = {}` per the delete/purge convention in [§5.10](#510-audit-log-entity). Rationale: a hidden row WAS user-visible — the destruction event itself is a domain event worth retaining even after the row is gone, distinct from the orphan-reaper case where a `pending` row never entered the domain.
- Each run emits exactly one structured operational log line at `info` level with fields `event = 'attachment-hidden-reaper'` (fixed discriminator), `ttl_minutes` (integer — the configured TTL applied, from the `[C]` catalogue above; the catalogue's "2 days" default expressed in minutes is `2880`), `removed_count` (non-negative integer — rows deleted in the run; `0` on a no-op run), `ran_at` (ISO 8601 timestamp of the run). Mirrors the orphan reaper's contract ([§6.11](#611-attachment-orphan-reaper)).
- No object-storage delete is issued — bytes are the bucket lifecycle's concern (`L` entry at [architecture.md §12.2](architecture.md#122-company-configurable-settings)). The reaper is DB-only.
- A per-row failure (DB transient error inside `mutate()`) is logged under the same event with `error_hint` populated; the sweep continues with the next row. Partial progress is acceptable — the next sweep picks up anything left behind, parity with the orphan reaper ([§6.11](#611-attachment-orphan-reaper)).
- Sweeps are single-flight: a tick that finds the previous sweep still running is skipped. Implementation rests on the periodic-sweeper infrastructure shared with §6.11.
- An in-flight sweep is drained on graceful shutdown before the database pool closes — parity with the orphan reaper ([§6.11](#611-attachment-orphan-reaper)) and the session reaper ([verification.md AC-132](verification.md#159-infrastructure)).

---

## 7. Seed Data Specification

The seed dataset is loaded into the database on initial setup and provides a realistic snapshot.

The seed operation must be safe to run on an empty database. Re-seeding an existing database drops and recreates all seed records. This is a development/demo operation, not a production upgrade path.

The loader is split by shape: users are read from a JSON fixture and inserted via a direct-DB path (users are outside the import envelope contract — see [§5.8](#58-export-envelope) and [api.md §14.2.4](api.md#1424-unified-data-exchange)); business data (customers, projects, project_workers) is assembled into an in-memory envelope and applied through the same import code path that serves [api.md §14.2.4](api.md#1424-unified-data-exchange), so every seed run exercises the import contract.

### 7.1 Project Dataset

**19 projects**, distributed to create a realistic snapshot with visible action-state accumulation:

| State           | Count | Notes                                                                      |
| --------------- | ----- | -------------------------------------------------------------------------- |
| Anfrage         | 2     | Recent, no dates planned. One received yesterday, one 10 days ago (stale). |
| Angebot         | 2     | One sent 3 days ago, one sent 18 days ago (exceeds aging threshold).       |
| Beauftragt      | 2     | Confirmed, no dates yet.                                                   |
| Geplant         | 2     | Dates assigned, workers assigned.                                          |
| In Arbeit       | 3     | Currently on-site. One slightly past `plannedEnd`.                         |
| Abnahme         | 1     | Waiting for customer walk-through.                                         |
| Rechnung fällig | 3     | **Critical accumulation** — demonstrates the core value.                   |
| Abgerechnet     | 2     | Invoice sent, waiting for payment.                                         |
| Erledigt        | 2     | Recently completed and paid.                                               |

### 7.2 User Dataset

| Username      | Display Name           | Roles      | Notes                                            |
| ------------- | ---------------------- | ---------- | ------------------------------------------------ |
| `inhaber`     | Thomas Berger          | owner      | Default admin account                            |
| `buero`       | Maria Schmidt          | office     | Office manager                                   |
| `arbeiter1`   | Jan Nowak              | worker     | Field worker                                     |
| `arbeiter2`   | Lukas Fischer          | worker     | Field worker                                     |
| `buchhalter`  | Petra Weiß             | bookkeeper | External bookkeeper                              |
| `deaktiviert` | Ehemaliger Mitarbeiter | worker     | Inactive — exercises the soft-delete path (§6.9) |

All seed users have a default password: `changeme` **[C]**. The seed loader must log a warning that default passwords are in use and must be changed.

In the default configuration, the `owner` role carries administrator privileges (user management access). This mapping is configurable **[C]**.

Names are assumed and fictional (per [ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md)).

### 7.3 Customer Dataset

**21 customers**, covering a range of data completeness and project associations:

| Name                      | Phone           | Email                    | Address                                 | Notes                                 |
| ------------------------- | --------------- | ------------------------ | --------------------------------------- | ------------------------------------- |
| Familie Müller            | +49 221 1234567 | mueller@example.de       | Hauptstr. 12, 51465 Bergisch Gladbach   | Stammkunde seit 2019                  |
| Schmidt GmbH              | +49 221 9876543 | info@schmidt-gmbh.de     | Industriestr. 8, 50968 Köln             | Gewerblicher Kunde                    |
| Petra Wagner              | +49 2202 54321  | p.wagner@email.de        | Am Stadtpark 3, 51429 Bergisch Gladbach | —                                     |
| Hausverwaltung Rheinblick | +49 221 5551234 | verwaltung@rheinblick.de | Rheinuferstr. 44, 50996 Köln            | Mehrere Objekte                       |
| Andreas Hoffmann          | +49 221 7773456 | —                        | Lindenweg 7, 51109 Köln                 | —                                     |
| Familie Yılmaz            | +49 2202 88990  | yilmaz.familie@email.de  | Gartenstr. 21, 51465 Bergisch Gladbach  | —                                     |
| Karl-Heinz Becker         | —               | —                        | —                                       | Nur Telefonkontakt — Nummer verlegt   |
| Weber Immobilien KG       | +49 221 4449876 | kontakt@weber-immo.de    | Aachener Str. 155, 50931 Köln           | Rahmenvertrag für Instandhaltung      |
| Schulz & Partner PartG    | +49 2204 61234  | office@schulz-partner.de | Kölner Str. 90, 51429 Bergisch Gladbach | Import aus orgaMAX, noch kein Projekt |
| Monika Engel              | +49 221 3336789 | —                        | —                                       | Import aus orgaMAX, noch kein Projekt |

Design notes:

- Customers with full data (name, phone, email, address): Familie Müller, Schmidt GmbH, Petra Wagner, Hausverwaltung Rheinblick, Familie Yılmaz, Weber Immobilien KG.
- Customers with minimal data (name only or name + phone): Karl-Heinz Becker (name only), Andreas Hoffmann (no email).
- Customers linked to multiple seed projects: Familie Müller (2 projects), Schmidt GmbH (2 projects), Hausverwaltung Rheinblick (3 projects).
- Customers with no projects yet: Schulz & Partner PartG, Monika Engel — these represent records imported from an external system (e.g., orgaMAX) before project creation.

### 7.4 Edge Cases

The seed dataset should include varied data (missing dates, minimal fields, aged entries) to exercise edge cases. Specific edge case coverage is verified through the test specifications (see [verification.md §16](verification.md#16-test-specification)).

### 7.5 Date Range

Seed data dates must be **relative to the deployment date**, not hardcoded calendar dates. The seed loader calculates dates relative to "today" so the data is meaningful whenever it is first loaded.

The overall range covers roughly the past 4 weeks to the coming 4 weeks, providing meaningful content for both views.

### 7.6 Realism

Project titles, customer names, and addresses should be domain-representative for a German Handwerker company (see [index.md, section 4.1](index.md#41-company-profile)). Example: "Fassadenanstrich Müller", "Treppenhaussanierung Schmidt", "Malerarbeiten Bürokomplex Weber".
