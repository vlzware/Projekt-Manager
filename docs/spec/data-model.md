# Data Model

*Iteration 5 — April 2026 | Living document — updated as each iteration ships.*

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
  id: string;                  // UUID
  number: string;              // "2026-042" — year + sequential [C]
  title: string;               // "Fassadenanstrich Müller"
  status: WorkflowState;
  statusChangedAt: string;     // ISO 8601 — for aging calculations

  customer: {
    name: string;              // "Familie Müller"
    phone?: string;            // "+49 221 1234567"
    email?: string;            // "mueller@example.de"
  };

  address?: {
    street: string;            // "Hauptstr. 12"
    zip: string;               // "51465"
    city: string;              // "Bergisch Gladbach"
  };

  plannedStart?: string;       // ISO 8601 date
  plannedEnd?: string;         // ISO 8601 date

  assignedWorkers?: string[];  // display names — placeholder; future iterations will use Worker entity IDs
  estimatedValue?: number;     // EUR net
  notes?: string;

  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
  createdBy?: string;          // UserAccount.id — optional: seeded/imported records may lack a known actor
  updatedBy?: string;          // UserAccount.id — optional: seeded/imported records may lack a known actor
}
```

Design notes:

- `statusChangedAt` is separate from `updatedAt` — editing notes must not reset aging calculations.
- Customer and address are nested objects for clarity and future extensibility. **Known debt**: `customer` is inline (denormalized). Future iterations will extract to a `Customer` entity for cross-project lookup, deduplication, and LLM email extraction.
- `assignedWorkers` is `string[]` of display names. **Known debt**: will be replaced by `Worker` entity references for role-based views and worker management.
- `estimatedValue` is `number` in the API contract. The database stores it as `numeric(12,2)` for precision. The ORM converts between the two representations; clients always receive and send a JSON number.
- No `priority` field — priority is implicit in state aging and column accumulation.
- No stored boolean flags for warnings — these are derived from state and timestamps at render time.
- Internal keys use English; German labels are applied at the UI layer.
- The `WorkflowState` type shown here reflects the current default configuration. In implementation, the state set is driven by the configuration array — the type is derived from configuration, not hardcoded independently (see [index.md, section 3](index.md#3-workflow-states)).
- `createdBy` / `updatedBy` follow the audit metadata rules defined in section 5.5.

### 5.2 State Metadata

```typescript
type StateType = 'action' | 'buffer' | 'active' | 'done';

interface StateConfig {
  key: WorkflowState;
  label: string;               // German display label
  type: StateType;
  order: number;               // position in workflow sequence (1-9)
  color: string;               // hex color
  agingThresholdDays?: number; // days before aging indicator appears [C]
  agingBoldDays?: number;      // days before date display turns bold [C]
  collapseTier: 1 | 2 | 3;        // responsive collapse priority (1 = last to collapse) [C]
}
```

This configuration drives Kanban column rendering, color coding, and aging indicators from a single source.

**Aging field mapping by state type:**

| State type | `agingBoldDays` | `agingThresholdDays` | Visual effect |
|---|---|---|---|
| Action | Used | Ignored | Entry date turns **bold** after threshold |
| Buffer | Used (equals `agingThresholdDays`) | Used | Entry date turns **bold** at the same threshold + `"seit X Tagen"` text appears |
| Active | Ignored | Ignored | No aging behavior |
| Done | Ignored | Ignored | No aging behavior |

### 5.3 User Entity

```typescript
type AccountRole = string; // internal key — e.g. 'owner', 'office', 'worker', 'bookkeeper' [C]

interface UserAccount {
  id: string;                  // UUID
  username: string;            // unique, used for login
  displayName: string;         // shown in UI, e.g. "Maria Schmidt"
  passwordHash: string;        // server/DB only — NEVER in API responses or client-side code
  roles: AccountRole[];        // array — see design notes
  email?: string;
  active: boolean;             // soft-disable without deletion
  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
  lastLoginAt?: string;        // ISO 8601
  createdBy?: string;          // UserAccount.id — optional for seeded/bootstrapped records
  updatedBy?: string;          // UserAccount.id — optional for seeded/bootstrapped records
}
```

Design notes:

- `createdBy` / `updatedBy` follow the audit metadata pattern (section 5.5). **No self-referential FK**: a foreign key from `users.createdBy` back to `users.id` would complicate bootstrapping (the first admin user cannot reference a creator that doesn't exist yet) and deletion cascades, without adding meaningful integrity guarantees. The columns are nullable UUIDs with no constraint.
- `roles` is an array even if iteration 2 uses only a minimal role set. This keeps the door open for owner, office, worker, bookkeeper, admin, or company-specific roles in later iterations without requiring a schema change.
- **[C]** `AccountRole` values are internal keys. German display labels (e.g. "Eigentümer", "Büro", "Arbeiter", "Buchhalter") are applied by configuration — the same pattern as workflow state labels.
- `passwordHash` is included in the entity definition for completeness but is **never** included in API responses or the client-side data model. The hashing algorithm is an infrastructure concern (not specified here).
- `active` allows disabling a user without deleting their records — important for audit trail in later iterations. Users are deactivated, not deleted.
- `lastLoginAt` is optional; populated on successful authentication.
- **Known debt**: iteration 2 implements a minimal role set. Future iterations may add fine-grained permissions, per-role view restrictions, or company-specific role definitions. The current array-based model supports this without structural changes.
- **Known debt**: no link between `UserAccount` and `Project.assignedWorkers`. The worker assignment remains a `string[]` of display names in this iteration. Connecting them is deferred to the iteration that introduces the worker-specific view.

### 5.4 Session

The session model is intentionally minimal and mechanism-agnostic. The spec defines what is tracked, not the transport mechanism (cookie vs. token is an implementation/ADR decision).

```typescript
interface Session {
  id: string;                  // opaque session identifier
  userId: string;              // references UserAccount.id
  token: string;               // cryptographically random lookup key — transport mechanism detail
  createdAt: string;           // ISO 8601
  expiresAt: string;           // ISO 8601
}
```

Design note: The `token` field is the value delivered to the client (e.g., via cookie). It is cryptographically random and opaque. The delivery mechanism (HttpOnly cookie vs. bearer token) is an ADR decision.

Session validation must verify that the referenced user is still active (`active = true`). If the user has been deactivated, the session is treated as invalid regardless of its `expiresAt`.

Password changes invalidate all other sessions for the affected user (`AuthService.changePassword()`).

### 5.5 Audit Metadata

All persisted entities follow a common audit metadata pattern:

```typescript
interface AuditMetadata {
  createdAt: string;           // ISO 8601 — set on creation, never modified
  updatedAt: string;           // ISO 8601 — set on every mutation
  createdBy?: string;          // UserAccount.id — optional for seeded/imported records
  updatedBy?: string;          // UserAccount.id — optional for seeded/imported records
}
```

Rules:

- `createdAt` and `updatedAt` are managed by the server. Clients never send these fields in mutations.
- User-triggered mutations must set `updatedBy` to the authenticated user's ID and update `updatedAt`.
- `createdBy` and `updatedBy` are optional because seeded, imported, or system-generated records may not have a known actor.
- This pattern applies to `Project` and `UserAccount`. `Session` uses `createdAt` and `expiresAt` only (sessions are not user-editable).

---

## 6. Persistence Principles

The product specification defines persistence behavior, not a concrete database technology or schema.

### 6.1 Durability

- Project data must survive page reloads, browser restarts, and deployment restarts.
- The application must read and write data only through a backend/API boundary.

### 6.2 Future Entity Extraction

The persistence design must support future extraction of additional entities without rewriting the project UI:

- `Customer` — extracted from inline `Project.customer`
- `Worker` — extracted from `Project.assignedWorkers`
- `Attachment` — file references for worker uploads (Aufmaß, photos)
- `NotificationRule` — event-based notification configuration
- `Invoice` — invoice tracking for the bookkeeper view
- `CompanySettings` — per-company configuration

The current iteration may store some data denormalized for simplicity, but must not make later normalization prohibitively expensive.

### 6.3 Record Identity

- Every persisted entity must have a stable, opaque ID.
- IDs must not encode workflow state, dates, or company-specific semantics.

### 6.4 Concurrency

Low write concurrency is assumed, but the design must tolerate multiple concurrent users accessing the system simultaneously.

At current scale (1–5 users), last-write-wins is acceptable. A future iteration may introduce optimistic concurrency control (e.g., `updatedAt`-based conflict detection) when multi-user editing becomes frequent. The chosen conflict handling strategy should be documented in an ADR.

### 6.5 Schema Evolution

- The persistence layer must support schema evolution via versioned migrations. The database can be created from scratch by running all migrations in order.
- No manual database resets as the primary upgrade strategy.
- Migrations are versioned and reproducible.
- Seed data is separate from migrations — loaded by a distinct operation, not baked into migration files. This allows re-seeding or clearing seed data without re-running schema changes.

### 6.6 Referential Integrity

- The database enforces foreign keys where relationships exist (e.g., `Session.userId` references `UserAccount.id`, `Project.createdBy`/`updatedBy` reference `UserAccount.id`).
- **Exception**: `UserAccount.createdBy`/`updatedBy` are nullable UUIDs with no FK constraint. A self-referential FK on the users table would complicate bootstrapping and deletion without adding meaningful integrity (see §5.3 design notes).
- Orphaned records are not acceptable.

### 6.7 Timestamps

Timestamp ownership rules are defined in section 5.5. Additionally, `statusChangedAt` is set by the server on state transitions, never by client input.

**Storage vs. API representation**: the database stores timestamps as PostgreSQL `timestamp with time zone`. The API serializes them as ISO 8601 strings (e.g., `"2026-04-10T14:30:00.000Z"`). The client receives and sends ISO 8601 strings; the ORM handles conversion transparently. The spec uses `string` (ISO 8601) in entity type definitions to describe the API contract, not the storage type.

### 6.8 Date Validation

- If both `plannedStart` and `plannedEnd` are provided, `plannedEnd` must not be before `plannedStart`.
- Either date may be null (cleared). Setting only `plannedStart` without `plannedEnd` is valid (renders as single-day block in calendar).
- Setting only `plannedEnd` without `plannedStart` is not valid — the API rejects this combination, **and the database enforces the same invariant via the `projects_end_requires_start` CHECK constraint**. This is defense in depth for direct DB writes (seed scripts, migrations, manual SQL) that bypass the route layer.
- The API rejects all invalid date combinations.

### 6.9 Soft Deletes

- Users are deactivated (`active = false`), not deleted. This preserves referential integrity and supports audit trail in later iterations.
- Projects do not support deletion in this iteration.

---

## 7. Seed Data Specification

The seed dataset is loaded into the database on initial setup and provides a realistic snapshot.

The seed operation must be safe to run on an empty database. Re-seeding an existing database drops and recreates all seed records. This is a development/demo operation, not a production upgrade path.

### 7.1 Project Dataset

**15-20 projects**, distributed to create a realistic snapshot with visible action-state accumulation:

| State | Count | Notes |
|---|---|---|
| Anfrage | 2 | Recent, no dates planned. One received yesterday, one 10 days ago (stale). |
| Angebot | 2 | One sent 3 days ago, one sent 18 days ago (exceeds aging threshold). |
| Beauftragt | 2 | Confirmed, no dates yet. |
| Geplant | 2 | Dates assigned, workers assigned. |
| In Arbeit | 3 | Currently on-site. One slightly past `plannedEnd`. |
| Abnahme | 1 | Waiting for customer walk-through. |
| Rechnung fällig | 3 | **Critical accumulation** — demonstrates the core value. |
| Abgerechnet | 2 | Invoice sent, waiting for payment. |
| Erledigt | 2 | Recently completed and paid. |

### 7.2 User Dataset

| Username | Display Name | Roles | Notes |
|---|---|---|---|
| `inhaber` | Thomas Berger | owner | Default admin account |
| `buero` | Maria Schmidt | office | Office manager |
| `arbeiter1` | Jan Nowak | worker | Field worker |
| `arbeiter2` | Lukas Fischer | worker | Field worker |
| `buchhalter` | Petra Weiß | bookkeeper | External bookkeeper |
| `deaktiviert` | Ehemaliger Mitarbeiter | worker | Inactive — exercises the soft-delete path (§6.9) |

All seed users have a default password: `changeme` **[C]**. The seed loader must log a warning that default passwords are in use and must be changed.

In the default configuration, the `owner` role carries administrator privileges (user management access). This mapping is configurable **[C]**.

Names are assumed and fictional (per [ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md)).

### 7.3 Edge Cases

The seed dataset should include varied data (missing dates, minimal fields, aged entries) to exercise edge cases. Specific edge case coverage is verified through the test specifications (see [verification.md §16](verification.md#16-test-specification)).

### 7.4 Date Range

Seed data dates must be **relative to the deployment date**, not hardcoded calendar dates. The seed loader calculates dates relative to "today" so the data is meaningful whenever it is first loaded.

The overall range covers roughly the past 4 weeks to the coming 4 weeks, providing meaningful content for both views.

### 7.5 Realism

Project titles, customer names, and addresses should be domain-representative for a German Handwerker company (see [index.md, section 4.1](index.md#41-company-profile)). Example: "Fassadenanstrich Müller", "Treppenhaussanierung Schmidt", "Malerarbeiten Bürokomplex Weber".

---

*Living document — updated as each iteration ships. Git history preserves past versions.*
