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
| **Transition forward**  | project ID                                                                                                       | updated project           | Advances status by one step. Rejects if current state is `erledigt`. Sets `status`, `statusChangedAt`, `updatedAt`, and `updatedBy` server-side.                                                                                                                                                                                                                                    |
| **Transition backward** | project ID                                                                                                       | updated project           | Moves status back by one step. Rejects if current state is `anfrage` or `erledigt`. Sets `status`, `statusChangedAt`, `updatedAt`, and `updatedBy` server-side.                                                                                                                                                                                                                     |
| **Update dates**        | project ID, plannedStart?, plannedEnd?                                                                           | updated project           | Updates date fields. Sets `updatedAt` and `updatedBy` server-side. Does **not** modify `statusChangedAt` — date changes must not reset aging calculations.                                                                                                                                                                                                                          |
| **Create project**      | id?, number, title, customerId, status?, plannedStart?, plannedEnd?, assignedWorkerIds?, estimatedValue?, notes? | created project           | Creates a single project. `number`, `title`, and `customerId` are required. `status` defaults to the first workflow state if omitted. `customerId` must reference an existing Customer. An optional client-supplied `id` enables idempotent replay (see design notes). Requires `project:create` permission.                                                                        |
| **Update project**      | project ID, title?, customerId?, assignedWorkerIds?, estimatedValue?, notes?                                     | updated project           | Updates the specified fields. PATCH semantics — omitted fields are unchanged. Explicitly passing `null` for an optional field clears it. Does **not** accept status changes (use transition operations), date changes (use Update dates), or project number changes (immutable after creation). Requires `project:update` permission. Sets `updatedAt` and `updatedBy` server-side. |
| **Delete project**      | project ID                                                                                                       | success/failure           | Soft-deletes the project (archive from board, see [data-model.md §6.9](data-model.md#69-soft-deletes)). Requires `project:delete` permission. A deleted project does not appear in list results or views.                                                                                                                                                                           |

**Project list filter parameters:** `status` (single or multiple), `customerId`, `plannedStartFrom`/`plannedStartTo` (date range), `hasNoDates` (boolean), `search` (free-text across number, title, and customer name). Filters use AND logic. These filters serve both the project management view and the export operation.

Design notes:

- **Transitions are explicit operations**, not generic field updates — workflow adjacency rules are enforceable server-side.
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

#### 14.2.4 Bulk Operations

Bulk and export operations support data exchange with external systems. Import operations submit many items in a single request with partial-success semantics. Export operations return data in a portable format for downstream consumption (bookkeeping software, external reports, data migration).

Import operations follow a uniform shape: each item is validated independently, valid items are persisted, and the response reports both how many succeeded and which ones failed (with the index in the input array and a German error message).

| Operation                 | Input                                                                                                                                                                                                                                                    | Output                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bulk import projects**  | array of project items, each with the same fields as a single project (`number`, `title`, `customerId`, optional `status`, optional `plannedStart`/`plannedEnd`, optional `assignedWorkerIds` (user UUIDs), optional `estimatedValue`, optional `notes`) | `{ imported: number, errors: { index: number, message: string }[] }`                  | Each item is validated independently. The endpoint never aborts on the first invalid item — partial success is the expected outcome. Items with `status` omitted default to the first workflow state. `customerId` must reference an existing Customer. Requires the `project:create` permission.                                                               |
| **Bulk import customers** | array of customer items, each with: `name`, optional `phone`, `email`, `address`, `notes`                                                                                                                                                                | `{ imported: number, updated: number, errors: { index: number, message: string }[] }` | Same partial-success semantics as project import. When an imported customer matches an existing customer by name, the existing record is updated (overwrite). `imported` counts new records, `updated` counts overwrites. The UI warns the user about matches before submitting (see [ui.md §8.11.1](ui.md#8111-import)). Requires `customer:write` permission. |
| **Export projects**       | optional: format (`json`), optional: filter (by status, by customerId, by date range)                                                                                                                                                                    | array of project objects (full shape including nested customer)                       | Returns all non-deleted projects matching the filter criteria. Default format is JSON. Requires `project:read` permission.                                                                                                                                                                                                                                      |
| **Export customers**      | optional: format (`json`), optional: filter (has-projects, no-projects)                                                                                                                                                                                  | array of customer objects                                                             | Returns all customers matching the filter criteria. Default format is JSON. Requires `customer:read` permission.                                                                                                                                                                                                                                                |

Design notes:

- **Partial success is required.** Invalid rows do not block valid rows. The response provides enough information for the user to fix rejected rows.
- **Import validation applies all entity rules** — same invariants as single-item creation (date validation, FK references, uniqueness).
- **No transactional all-or-nothing semantics.** Rows that fail after validation (e.g., uniqueness constraint) are reported in `errors`; others still commit. Database errors are translated to German messages — no internal details leak.
- **Uniform result shape.** All bulk operations follow `{ imported, [updated,] errors }`.
- **Export** returns the full entity shape. `format` parameter currently accepts only `json`.
- **Export filters** are optional, use AND logic.

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

- **Client-supplied `id` is optional.** When omitted, the server generates one. When supplied, it must be a syntactically valid id or the request is rejected as a validation error.
- **Idempotent replay.** If a row with the supplied id already exists AND every user-supplied field in the request body matches the stored row, the existing row is returned with the same success status as a fresh create. Replays do not create duplicates.
- **Field comparison for replay.** Participating fields: `name`, `phone`, `email`, `address`, `notes`. Rules: `null`, `undefined`, and missing are equivalent; nested address fields (`street`, `zip`, `city`) compare component-wise under the same rule.
- **Idempotency conflict.** If a row with the supplied id exists but any participating field differs, the request is rejected with a conflict error code `IDEMPOTENCY_CONFLICT` (see [§14.4](#144-error-handling)). The stored row is not modified.
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

| Role       | Permissions                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| owner      | project:read, project:transition, project:dates, project:create, project:update, project:delete, customer:read, customer:write, customer:delete, user:read, user:manage, user:delete, auth:change-password |
| office     | project:read, project:transition, project:dates, project:create, project:update, project:delete, customer:read, customer:write, user:read, auth:change-password                                            |
| worker     | project:read, customer:read, auth:change-password                                                                                                                                                          |
| bookkeeper | project:read, customer:read, auth:change-password                                                                                                                                                          |

Design notes:

- **Import permissions follow create/write permissions.** Bulk import of projects requires `project:create`; bulk import of customers requires `customer:write`. There are no separate import-specific permissions.
- **Export permissions follow read permissions.** Exporting projects requires `project:read`; exporting customers requires `customer:read`. Since all authenticated users have read permissions, all authenticated users can export.
- The API must be designed so that scoping reads to a subset (e.g. "projects assigned to user X") is an additive query filter on the list operation, not a restructuring of the endpoint.
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
