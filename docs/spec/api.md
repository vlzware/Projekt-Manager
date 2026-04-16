# API Specification

---

## 14. API Specification

The API is the boundary between the front end and all persistent state ([architecture.md §11.1](architecture.md#111-mandatory-constraints)). The front end's state layer is a client of this API (see [architecture.md §11.3](architecture.md#113-state-layer-behavioral-contract)).

### 14.1 Design Principles

- **Single source of truth.** The API is authoritative for all persisted data.
- **Stack-agnostic contract.** Operations, inputs, and outputs — not transport, URLs, or serialization.
- **Consistent error representation.** Machine-readable code + human-readable message (see [§14.4](#144-error-handling)).
- **Stateless requests.** Each request carries all context needed, including authentication.
- **Pagination-ready.** List operations accept `offset`/`limit`. The contract must support pagination even if the current data volume does not require it.
- **Stable list order.** List operations return rows in a deterministic order — a second fetch yields the same sequence, and pagination pages do not overlap or skip rows.
- **Timestamps managed server-side.** `createdAt`, `updatedAt`, `statusChangedAt` are set by the server, never by clients.

---

### 14.2 Operations

#### 14.2.0 Health

| Operation        | Input | Output                                                                | Notes                                                                                                                                                |
| ---------------- | ----- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Health check** | —     | status (`ok` or `degraded`), per-component checks (database, storage) | No authentication required. Returns degraded with component-level detail if any probe fails. Used by the deploy script for post-deploy verification. |

#### 14.2.1 Authentication

| Operation            | Input              | Output                                                                                                        | Notes                                                                                                                                                                                                                                                 |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login**            | username, password | session token, user profile (id, username, displayName, roles, email, themePreference) enveloped under `user` | Creates a new session. Rejects inactive users (`active = false`).                                                                                                                                                                                     |
| **Logout**           | session token      | --                                                                                                            | Invalidates the specific session, not all sessions for the user.                                                                                                                                                                                      |
| **Get current user** | (session)          | user profile (id, username, displayName, roles, email, themePreference) enveloped under `user`                | Returns the authenticated user's profile under the same `{ user: ... }` envelope as Login, so a typed client shares one response type. Used on app load to restore session (see [ui.md — Authentication Behavior](ui.md#94-authentication-behavior)). |
| **Update self**      | themePreference?   | updated user profile enveloped under `user`                                                                   | Updates the authenticated user's own preferences. PATCH semantics — omitted fields are unchanged. Currently accepts `themePreference` only. Requires a valid session; no additional permission check (self-scope).                                    |

Design notes:

- Failed login returns a generic error — no distinction between "user not found" and "wrong password".
- User profiles never include `passwordHash`.
- **Update self** is restricted to the caller's own record. The endpoint cannot affect any other user and does not accept a user ID. Identity-bearing fields (`username`, `roles`, `active`) are never updatable through this operation — those remain administrative (see [§14.2.3](#1423-user-management)).
- **Update self error paths** (mapped to the categories in [§14.4.1](#1441-error-categories)): missing or invalid session → authentication error; request body violating the allowed value set (e.g., `themePreference` outside `'light' | 'dark' | 'system'`) → validation error.

#### 14.2.2 Projects

All project operations require an authenticated session.

| Operation               | Input                                                                                                            | Output                    | Notes                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List projects**       | optional: offset, limit, filters, search, sort                                                                   | project list, total count | Returns all non-deleted projects visible to the authenticated user. Supports pagination, filtering, searching, and sorting (see filter parameters below).                                                                                                                                                                                                                           |
| **Get project**         | project ID                                                                                                       | single project            | Returns the full project object or a not-found error.                                                                                                                                                                                                                                                                                                                               |
| **Transition forward**  | project ID, expectedStatus                                                                                       | updated project           | Advances status by one step. Requires `expectedStatus` — the status the client last observed; rejects with a conflict error if the stored status no longer matches (see design notes). Rejects as validation error if `expectedStatus` is `erledigt`. Sets `status`, `statusChangedAt`, `updatedAt`, and `updatedBy` server-side.                                                   |
| **Transition backward** | project ID, expectedStatus                                                                                       | updated project           | Moves status back by one step. Requires `expectedStatus` (same semantics as forward). Rejects as validation error if `expectedStatus` is `anfrage` or `erledigt`. Sets `status`, `statusChangedAt`, `updatedAt`, and `updatedBy` server-side.                                                                                                                                       |
| **Update dates**        | project ID, plannedStart?, plannedEnd?                                                                           | updated project           | Updates date fields. Sets `updatedAt` and `updatedBy` server-side. Does **not** modify `statusChangedAt` — date changes must not reset aging calculations.                                                                                                                                                                                                                          |
| **Create project**      | id?, number, title, customerId, status?, plannedStart?, plannedEnd?, assignedWorkerIds?, estimatedValue?, notes? | created project           | Creates a single project. `number`, `title`, and `customerId` are required. `status` defaults to the first workflow state if omitted. `customerId` must reference an existing Customer. An optional client-supplied `id` enables idempotent replay (see design notes). Requires `project:create` permission.                                                                        |
| **Update project**      | project ID, title?, customerId?, assignedWorkerIds?, estimatedValue?, notes?                                     | updated project           | Updates the specified fields. PATCH semantics — omitted fields are unchanged. Explicitly passing `null` for an optional field clears it. Does **not** accept status changes (use transition operations), date changes (use Update dates), or project number changes (immutable after creation). Requires `project:update` permission. Sets `updatedAt` and `updatedBy` server-side. |
| **Delete project**      | project ID                                                                                                       | success/failure           | Soft-deletes the project (archive from board, see [data-model.md §6.9](data-model.md#69-soft-deletes)). Requires `project:delete` permission. A deleted project does not appear in list results or views.                                                                                                                                                                           |

**Project list filter parameters:** `status` (single or multiple), `customerId`, `plannedStartFrom`/`plannedStartTo` (date range), `hasNoDates` (boolean), `search` (free-text across number, title, and customer name). Filters use AND logic. These filters serve both the project management view and the export operation.

Design notes:

- **Transitions are explicit operations**, not generic field updates — workflow adjacency rules are enforceable server-side.
- **Transition optimistic concurrency.** The client sends `expectedStatus` (the status it observed in its last read). The server advances only if the stored status still matches, otherwise the request is rejected with a `CONFLICT` error (see [§14.4](#144-error-handling)) — the client should refetch and present the current state. This deterministically prevents double-advance from sequential double-clicks, two tabs, or retried requests (see [data-model.md §6.4](data-model.md#64-concurrency) and [AC-94](verification.md#1517-data-integrity)).
- **Project number is immutable** after creation.
- **Soft delete**: no restore via the API. Deleted projects are excluded from all reads.
- **Full project object returned** after every mutation so the client can reconcile without a separate fetch.
- **Update-dates** treats `plannedStart` and `plannedEnd` as a coordinated update. Clearing `plannedStart` also clears `plannedEnd` (see [data-model.md §6.8](data-model.md#68-date-validation)). `plannedEnd` before `plannedStart` is rejected.
- **Concurrent edit handling**: see [data-model.md §6.4](data-model.md#64-concurrency).
- The project response nests the full Customer object for rendering convenience.
- **Client-supplied `id` is optional.** When omitted, the server generates one. When supplied, it must be a syntactically valid id or the request is rejected as a validation error.
- **Idempotent replay.** If a row with the supplied id already exists AND every user-supplied field in the request body matches the stored row, the existing row is returned with the same success status as a fresh create. Replays do not create duplicates.
- **Field comparison for replay.** Participating fields: `number`, `title`, `customerId`, `status`, `plannedStart`, `plannedEnd`, `assignedWorkerIds`, `estimatedValue`, `notes`. Rules: `null`, `undefined`, and missing are equivalent; `assignedWorkerIds` compares as a set (order-independent); `estimatedValue` is rounded to two decimals before comparison; `plannedStart` and `plannedEnd` compare as calendar dates.
- **Idempotency conflict.** If a row with the supplied id exists but any participating field differs, the request is rejected with a conflict error code `IDEMPOTENCY_CONFLICT` (see [§14.4](#144-error-handling)). The stored row is not modified.
- **Soft-deleted match.** If the matching row is soft-deleted (see [data-model.md §6.9](data-model.md#69-soft-deletes)), the replay returns the row in its current (deleted) state. Clients must inspect the response rather than assume the row is active.
- **`number` uniqueness is separate.** Creating a project whose `number` collides with another row's `number` (regardless of idempotency) is rejected with a conflict error code `CONFLICT` and a German message naming the conflicting number (see [§14.4](#144-error-handling)). This is distinct from `IDEMPOTENCY_CONFLICT`.

#### 14.2.3 User Management

| Operation               | Input                                          | Output                 | Notes                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List users**          | optional: offset, limit                        | user list, total count | Returns all users (including deactivated). Requires `user:read` permission. `passwordHash` is never included in responses.                                                                                                                                                                                                                         |
| **Get user**            | user ID                                        | single user            | Returns the full user object (minus `passwordHash`) or a not-found error. Requires `user:read` permission.                                                                                                                                                                                                                                         |
| **Create user**         | username, displayName, password, roles, email? | created user           | Creates a new user account. `username` must be unique. Password must meet the configured password policy (see [index.md §4.5](index.md#45-authentication)). Requires `user:manage` permission.                                                                                                                                                     |
| **Update user**         | user ID, displayName?, roles?, email?          | updated user           | Updates the specified fields. PATCH semantics. Does **not** allow changing `username` (immutable after creation). Does **not** accept password changes (use Reset password or Change own password). Requires `user:manage` permission.                                                                                                             |
| **Deactivate user**     | user ID                                        | updated user           | Sets `active = false`. Deactivation invalidates all sessions for the user. A deactivated user cannot log in. Requires `user:manage` permission. The acting user cannot deactivate themselves.                                                                                                                                                      |
| **Reactivate user**     | user ID                                        | updated user           | Sets `active = true`. Requires `user:manage` permission.                                                                                                                                                                                                                                                                                           |
| **Reset password**      | user ID, new password                          | success/failure        | Administrative password reset — does not require the user's current password. New password must meet the configured password policy. Session side effects per [data-model.md §5.4](data-model.md#54-session). Requires `user:manage` permission.                                                                                                   |
| **Change own password** | current password, new password                 | success/failure        | Any authenticated user can change their own password. Current password must be verified before accepting the change. New password must meet the configured password policy (see [index.md §4.5](index.md#45-authentication)). Session side effects per [data-model.md §5.4](data-model.md#54-session). Requires `auth:change-password` permission. |
| **Delete user**         | user ID                                        | success/failure        | Hard-deletes the user. Cascades sessions and worker assignments; `createdBy`/`updatedBy` references are set to null. Self-deletion is rejected. Requires `user:delete` permission (owner only).                                                                                                                                                    |

Design notes:

- Plaintext passwords are never stored or logged. The server hashes before storage.
- **Username is immutable** after creation.
- Users can be deactivated or hard-deleted. Deactivation preserves the record; deletion removes it. See [data-model.md §6.9](data-model.md#69-soft-deletes).
- **Self-deactivation and self-deletion are prohibited.**
- Password-change session side effects: see [data-model.md §5.4](data-model.md#54-session).

#### 14.2.4 Unified Data Exchange

A single export and a single restore-only import cover the business-data layer (customers, projects, project-worker assignments). Per-entity bulk endpoints do not exist. Rationale and the three-layer persistence model live in [ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md); the envelope shape is defined in [data-model.md §5.8](data-model.md#58-export-envelope).

| Operation  | Input                                                               | Output                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Export** | —                                                                   | unified envelope (see [data-model.md §5.8](data-model.md#58-export-envelope)) | Returns every customer, project, and project-worker assignment at row-level fidelity, including archived (soft-deleted) rows with archive state preserved. Users and sessions are excluded. Requires `data:export` permission.                                                                                                                                              |
| **Import** | unified envelope; optional `dry_run` flag; optional `override` flag | `{ schema_version, summary }` on success; validation preview on dry-run       | Restore-only semantics. Applied as a single transaction — all-or-nothing. Rejects any `schema_version` not equal to the current one; no format migration is performed. Empty target proceeds; non-empty target is rejected unless `override` is set, which wipes existing business data atomically before restoring. IDs are preserved. Requires `data:restore` permission. |

Design notes:

- **Envelope shape** — `{ schema_version: int, exported_at: ISO 8601 string, customers: Customer[], projects: Project[], project_workers: { projectId, userId }[] }`. Each entity carries every persisted field including `id`, audit timestamps, and archive state (see [data-model.md §5.8](data-model.md#58-export-envelope)).
- **Dry-run mode** — the client signals dry-run via `?dry_run=true` on the import request. The server runs full validation against the envelope (schema version, referential integrity, row-level constraints), returns a preview describing what would be written, and performs no writes. A subsequent read reflects no state change.
- **Override flag** — the client signals override via `?override=true`. When the target is non-empty, override wipes existing customers, projects, and project-worker assignments atomically with the restore. Without the flag, a non-empty target rejects the request with a specific error code.
- **Atomic failure** — if any row fails validation during a non-dry-run import (with or without override), no state change is persisted. The request has no partial outcome.
- **Schema version** — a monotonic integer. Exports stamp the current value; imports compare and reject mismatches outright (see [ADR-0018 §Decision](../adr/0018-data-persistence-and-recovery-layered-strategy.md#decision)).
- **Users and sessions are not exchanged** through this surface. Admin bootstrap ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)) creates the first user; test seeding uses a direct-DB helper confined to the test layer.

#### 14.2.5 Customer Management

All customer operations require an authenticated session.

| Operation           | Input                                                | Output                                         | Notes                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List customers**  | optional: offset, limit, search (name substring)     | customer list, total count                     | Returns all customers. Search parameter filters by name (case-insensitive substring match).                                                                                                                                                                                                                             |
| **Get customer**    | customer ID                                          | single customer, with associated project count | Returns the full customer object or a not-found error. Includes a count of projects referencing this customer.                                                                                                                                                                                                          |
| **Create customer** | id?, name, phone?, email?, address?, notes?          | created customer                               | Creates a new customer. `name` is required. An optional client-supplied `id` enables idempotent replay (see design notes). Requires `customer:write` permission.                                                                                                                                                        |
| **Update customer** | customer ID, name?, phone?, email?, address?, notes? | updated customer                               | Updates the specified fields. PATCH semantics — omitted fields are unchanged. Explicitly passing `null` for an optional field clears it. Requires `customer:write` permission.                                                                                                                                          |
| **Delete customer** | customer ID                                          | success confirmation                           | Hard-deletes the customer. Rejected as a conflict if active (non-archived) projects reference it; archived projects are purged atomically with the customer (see [data-model.md §5.6](data-model.md#56-customer-entity) and [§6.9](data-model.md#69-soft-deletes)). Requires `customer:delete` permission (owner only). |

Design notes:

- **Idempotent replay** follows the same contract as for projects — see [§14.2.2](#1422-projects) design notes for the client-supplied `id`, replay semantics, and `IDEMPOTENCY_CONFLICT` behavior.
- **Field comparison for replay.** Participating fields: `name`, `phone`, `email`, `address`, `notes`. Rules: `null`, `undefined`, and missing are equivalent; nested address fields (`street`, `zip`, `city`) compare component-wise under the same rule.
- **Duplicate-name handling is separate.** Name collisions are not blocked at the API — the client surfaces them (see [ui.md §8.9.2](ui.md#892-create-customer)). `IDEMPOTENCY_CONFLICT` addresses only retried writes keyed by a client-supplied id.

#### 14.2.6 Data Extraction

All extraction operations require an authenticated session and the `customer:write` permission. See [ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md) for the server-side proxy rationale.

| Operation         | Input                  | Output                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Extract email** | `text`: raw email text | `{ customer: { name, phone, email, street, zip, city }, project: { title, description } }` — all fields nullable strings | Routes the text to an external LLM via a server-side proxy. The text must be non-empty and not exceed 50,000 characters. The operation is read-only with respect to persistence — it returns extracted data for review; the client uses the existing customer and project creation operations ([§14.2.5](#1425-customer-management), [§14.2.2](#1422-projects)) to persist the reviewed result. Requires `customer:write` permission. |

Design notes:

- **Stateless with respect to persistence.** The extraction endpoint does not create, update, or delete any record. It is a pure read: email text in, structured data out.
- **Upstream failures are mapped to error categories.** Missing upstream configuration, a non-OK response from the external service, an empty response, or an unparseable response all resolve to a server error (see [§14.4.1](#1441-error-categories)). Internal details (service name, upstream status codes, stack traces) are not exposed.
- **Every field may be null.** The LLM returns `null` for information it could not find in the input. Clients must handle nulls across all fields.

---

### 14.3 Authorization Rules

- All API operations require authentication (valid, active session).
- The system implements a basic role-based permission matrix. All authenticated, active users can view all projects (list, get) and change their own password. Other operations — including mutations, imports, and exports — require specific permissions granted by role:

| Role       | Permissions                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| owner      | project:read, project:transition, project:dates, project:create, project:update, project:delete, customer:read, customer:write, customer:delete, user:read, user:manage, user:delete, data:export, data:restore, auth:change-password |
| office     | project:read, project:transition, project:dates, project:create, project:update, project:delete, customer:read, customer:write, user:read, data:export, auth:change-password                                                          |
| worker     | project:read, customer:read, auth:change-password                                                                                                                                                                                     |
| bookkeeper | project:read, customer:read, auth:change-password                                                                                                                                                                                     |

Design notes:

- **Data exchange permissions are distinct from entity read/write permissions.** `data:export` gates the unified export ([§14.2.4](#1424-unified-data-exchange)); `data:restore` gates the unified import. Granting `project:read` does not imply `data:export`.
- **`data:restore` is owner-only.** The import destroys or replaces business data in a single transaction — a destructive operation, reserved to the most privileged role consistent with `customer:delete` and `user:delete`.
- The API must be designed so that scoping reads to a subset (e.g. "projects assigned to user X") is an additive query filter on the list operation, not a restructuring of the endpoint.
- **Holding `project:read` does not imply unscoped access to every project; holding `customer:read` does not imply unscoped access to every customer.** For workers, reads (list and get) are scoped by caller identity — restricted to projects where the worker is in `project_workers`, and to customers referenced by those projects. Owner and office remain unscoped. Exactly one `project:read` and one `customer:read` exist in the matrix — this is observable in the table above. Bookkeeper has unscoped project and customer read as an MVP placeholder until an invoice-oriented view is introduced (see [index.md §4.2](index.md#42-users)). See also [AC-145](verification.md#1521-role-scoping), [AC-146](verification.md#1521-role-scoping), [AC-147](verification.md#1521-role-scoping), [AC-148](verification.md#1521-role-scoping).
- Authorization checks must be enforced server-side. Client-side UI hiding (e.g. hidden buttons) is a UX convenience, not a security measure (see [architecture.md §13.6](architecture.md#136-security)).

---

### 14.4 Error Handling

Every error response carries two components:

| Component                  | Purpose                               | Example                                                   |
| -------------------------- | ------------------------------------- | --------------------------------------------------------- |
| **Machine-readable code**  | Programmatic handling by the client   | `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `NOT_PERMITTED` |
| **Human-readable message** | Display to the user (German, **[C]**) | `"Anmeldung fehlgeschlagen"`, `"Sitzung abgelaufen"`      |

An optional third component, `details`, may carry structured validation information (e.g., field-level errors from schema validation). Clients should handle its absence gracefully.

#### 14.4.1 Error Categories

The API must distinguish the following error categories. Each category has distinct client-side handling (see [ui.md — Asynchronous Mutation Behavior](ui.md#95-asynchronous-mutation-behavior)).

| Category                 | Meaning                                                                                                                                                                                                                                   | Client behavior                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication error** | Credentials invalid, session expired, or session absent.                                                                                                                                                                                  | Redirect to login screen. Show expiry message if session was previously valid.                                                                                 |
| **Authorization error**  | User is authenticated but lacks permission for the requested operation (e.g., changing another user's password).                                                                                                                          | Show error message. Do not redirect to login.                                                                                                                  |
| **Validation error**     | Request is malformed or violates business rules (e.g., transition from `erledigt`, missing required field, invalid dates).                                                                                                                | Show error message. Revert optimistic update if applicable.                                                                                                    |
| **Not found**            | The requested entity (project or user ID) does not exist.                                                                                                                                                                                 | Show error message. Re-fetch project list to sync state.                                                                                                       |
| **Conflict**             | The mutation cannot proceed because the resource state has changed since it was read (e.g., concurrent state transition) or the operation conflicts with related state (e.g., deleting a customer with active projects).                  | Refetch resource state. Optionally retry against the new state.                                                                                                |
| **Idempotency conflict** | A create request carried a client-supplied `id` that already identifies a row, but one or more participating fields in the request body differ from the stored row (see [§14.2.2](#1422-projects), [§14.2.5](#1425-customer-management)). | Close the create form, refresh the affected list, surface the message. Do not retry the same id with the same body — the request is ambiguous by construction. |
| **Server error**         | Unexpected internal failure.                                                                                                                                                                                                              | Show generic error message. Do not expose internal details.                                                                                                    |
| **Rate limited**         | Too many requests in the configured time window.                                                                                                                                                                                          | Show retry message. Back off before retrying.                                                                                                                  |

The full set of machine-readable error codes: `INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `SESSION_EXPIRED`, `NOT_PERMITTED`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `SERVER_ERROR`.

#### 14.4.2 Error Principles

- **Authentication errors are distinguishable from authorization errors.** An expired session must not produce the same error as an insufficient permission — the client handles them differently (redirect vs. inline message).
- **Validation errors are structured.** When a mutation is rejected for business rule violations, the error must identify which rule was violated (e.g., "cannot transition from terminal state") so the client can render a meaningful message.
- **Error messages never leak internal details.** No stack traces, database field names, table names, file paths, or query information in any error response. This applies to all error categories including server errors.

---

_Cross-references: [index.md](index.md) for scope and assumptions, [data-model.md](data-model.md) for entity definitions, [ui.md](ui.md) for client-side behavior that consumes this API, [architecture.md](architecture.md) for responsibility layers and security requirements, [verification.md](verification.md) for acceptance criteria and API integration tests._
