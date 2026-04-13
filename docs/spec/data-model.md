# Data Model

---

## 5. Data Model

### 5.1 Project Entity

The entity is stored in the database. Two audit fields (`createdBy`, `updatedBy`) track the acting user.

```typescript
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

  assignedWorkers?: { userId: string; displayName: string }[]; // references UserAccount via project_workers join table
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

interface UserAccount {
  id: string; // UUID
  username: string; // unique, used for login
  displayName: string; // shown in UI, e.g. "Maria Schmidt"
  passwordHash: string; // server/DB only — NEVER in API responses or client-side code
  roles: AccountRole[]; // array — see design notes
  email?: string;
  active: boolean; // soft-disable without deletion
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
- Customers can be deleted (hard delete) only when no projects reference them. The `ON DELETE no action` FK constraint on `projects.customer_id` enforces this at the database level — a delete attempt on a customer with projects is rejected. Deletion requires the `customer:delete` permission (owner only). A customer without projects is a normal state (e.g., imported before project creation) and deleting such a record is a cleanup operation, not a data-integrity concern.

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

Low write concurrency is assumed, but the design must tolerate multiple concurrent users accessing the system simultaneously. Conflict handling is last-write-wins. Optimistic concurrency control is not part of this specification.

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
- Setting only `plannedEnd` without `plannedStart` is not valid — the API rejects this combination, **and the database enforces the same invariant via the `projects_end_requires_start` CHECK constraint**. This is defense in depth for direct DB writes (seed scripts, migrations, manual SQL) that bypass the route layer.
- The API rejects all invalid date combinations.

### 6.9 Soft Deletes

- Users can be deactivated (`active = false`) or hard-deleted. Deactivation is the default for preserving assignment history. Hard deletion is available to the owner role and cascades sessions and worker assignments; `createdBy`/`updatedBy` references are set to null. Self-deletion is rejected by the API.
- Projects are soft-deleted (`deleted = true`). Deleted projects are excluded from list and read operations but retained in the database for audit purposes and referential integrity.

---

## 7. Seed Data Specification

The seed dataset is loaded into the database on initial setup and provides a realistic snapshot.

The seed operation must be safe to run on an empty database. Re-seeding an existing database drops and recreates all seed records. This is a development/demo operation, not a production upgrade path.

### 7.1 Project Dataset

**15-20 projects**, distributed to create a realistic snapshot with visible action-state accumulation:

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

**8–10 customers**, covering a range of data completeness and project associations:

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
