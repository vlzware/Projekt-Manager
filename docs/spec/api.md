# API Specification

---

## 14. API Specification

The API is the boundary between the front end and all persistent state. It replaces direct in-memory state mutations for any operation that affects stored data. The front end's state layer becomes a client of this API (see [architecture.md — State Layer Contract](architecture.md#113-state-layer-behavioral-contract)).

### 14.1 Design Principles

- **Single source of truth.** The API is authoritative for all project and user data. The client may cache data locally for rendering, but the server state is canonical.
- **Stack-agnostic contract.** This section defines operations, inputs, and outputs — not transport protocol, URL structure, or serialization format. Those are implementation decisions (ADR territory).
- **Consistent error representation.** Every operation can fail. Errors carry a machine-readable code and a human-readable message (see [14.4 Error Handling](#144-error-handling)). The spec does not prescribe HTTP status codes or error envelope formats.
- **Stateless requests.** Each request carries all context needed for the server to fulfill it, including authentication credentials. The server does not rely on prior requests.
- **Pagination-ready.** List operations accept optional `offset`/`limit` parameters. For the current data volume (10-30 projects), the server may return all results, but the contract must support pagination so the front end does not assume unbounded responses.
- **Timestamps managed server-side.** `createdAt`, `updatedAt`, and `statusChangedAt` are set by the server. Clients never send these fields in mutations (see [data-model.md — Audit Metadata](data-model.md#55-audit-metadata)).

---

### 14.2 Operations

#### 14.2.0 Health

| Operation        | Input | Output                                                                | Notes                                                                                                                                                |
| ---------------- | ----- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Health check** | —     | status (`ok` or `degraded`), per-component checks (database, storage) | No authentication required. Returns degraded with component-level detail if any probe fails. Used by the deploy script for post-deploy verification. |

#### 14.2.1 Authentication

| Operation            | Input              | Output                                                                                       | Notes                                                                                                                                                                                                                                                 |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login**            | username, password | session token, user profile (id, username, displayName, roles, email) enveloped under `user` | Creates a new session. Rejects inactive users (`active = false`).                                                                                                                                                                                     |
| **Logout**           | session token      | --                                                                                           | Invalidates the specific session, not all sessions for the user.                                                                                                                                                                                      |
| **Get current user** | (session)          | user profile (id, username, displayName, roles, email) enveloped under `user`                | Returns the authenticated user's profile under the same `{ user: ... }` envelope as Login, so a typed client shares one response type. Used on app load to restore session (see [ui.md — Authentication Behavior](ui.md#94-authentication-behavior)). |

Design notes:

- Failed login returns a generic error — no distinction between "user not found" and "wrong password" to avoid information leakage. The error message is suitable for display on the login screen.
- The user profile returned by Login and Get current user never includes `passwordHash` (see [data-model.md — User Entity](data-model.md#53-user-entity)).
- Get current user allows the client to check on app load whether an existing session is still valid without requiring a fresh login.
- Session duration and token format are implementation decisions (ADR territory).

#### 14.2.2 Projects

All project operations require an authenticated session.

| Operation               | Input                                                                                                       | Output                    | Notes                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List projects**       | optional: offset, limit                                                                                     | project list, total count | Returns all projects visible to the authenticated user. The contract accepts pagination parameters even when the current data volume does not require the server to paginate.                                                                                                                                                                                                       |
| **Get project**         | project ID                                                                                                  | single project            | Returns the full project object or a not-found error.                                                                                                                                                                                                                                                                                                                               |
| **Transition forward**  | project ID                                                                                                  | updated project           | Advances status by one step. Rejects if current state is `erledigt`. Sets `status`, `statusChangedAt`, `updatedAt`, and `updatedBy` server-side.                                                                                                                                                                                                                                    |
| **Transition backward** | project ID                                                                                                  | updated project           | Moves status back by one step. Rejects if current state is `anfrage` or `erledigt`. Sets `status`, `statusChangedAt`, `updatedAt`, and `updatedBy` server-side.                                                                                                                                                                                                                     |
| **Update dates**        | project ID, plannedStart?, plannedEnd?                                                                      | updated project           | Updates date fields. Sets `updatedAt` and `updatedBy` server-side. Does **not** modify `statusChangedAt` — date changes must not reset aging calculations.                                                                                                                                                                                                                          |
| **Create project**      | number, title, customerId, status?, plannedStart?, plannedEnd?, assignedWorkerIds?, estimatedValue?, notes? | created project           | Creates a single project. `number`, `title`, and `customerId` are required. `status` defaults to the first workflow state if omitted. `customerId` must reference an existing Customer. Requires `project:create` permission.                                                                                                                                                       |
| **Update project**      | project ID, title?, customerId?, assignedWorkerIds?, estimatedValue?, notes?                                | updated project           | Updates the specified fields. PATCH semantics — omitted fields are unchanged. Explicitly passing `null` for an optional field clears it. Does **not** accept status changes (use transition operations), date changes (use Update dates), or project number changes (immutable after creation). Requires `project:update` permission. Sets `updatedAt` and `updatedBy` server-side. |
| **Delete project**      | project ID                                                                                                  | success/failure           | Soft-deletes the project. The record is marked as deleted but retained for audit purposes. Requires `project:delete` permission. A deleted project does not appear in list results or views.                                                                                                                                                                                        |

Design notes:

- **Transitions are explicit operations**, not generic field updates. This preserves the workflow rule that only adjacent states are reachable (see [ui.md — State Transitions](ui.md#91-state-transitions)) and makes the business rule enforceable server-side.
- **Project creation** is available as both a single-item operation and via bulk import (see [§14.2.4](#1424-bulk-operations)).
- **Update-project** is a general-purpose field update, separate from the targeted update-dates and transition operations. The separate operations exist because transitions and date changes have distinct business rules (adjacency, aging) that warrant explicit enforcement. Update-project handles all other editable fields.
- **Project number is immutable** after creation — it serves as a human-readable external identifier and must remain stable for cross-referencing with external documents (offers, invoices).
- **Soft delete**: deleted projects are retained in the database for audit and referential integrity but excluded from all list and read operations. Once deleted, a project cannot be restored via the API.
- **Full project object returned** after every mutation so the client can update its local state without a separate fetch.
- **Update-dates PATCH semantics**: the operation takes both `plannedStart` and `plannedEnd` as optional fields, and treats them as a coordinated update rather than independent PATCHes.
  - Setting `plannedStart` to `null` explicitly clears it — and because the invariant `plannedEnd without plannedStart` is forbidden (see [data-model.md §6.8](data-model.md#68-date-validation)), the server also clears `plannedEnd` in the same transaction. This is the "clear the dates" gesture from the UI (Detail Panel clearing start also clears end, see [ui.md §8.4](ui.md#84-project-detail-panel)).
  - Omitting a field leaves it unchanged (standard PATCH semantics).
  - Setting `plannedEnd` to a value requires `plannedStart` to be present (either sent in the same request or already on the row); otherwise the operation is rejected with a validation error.
  - `plannedEnd` before `plannedStart` is rejected with a validation error.
- **Concurrent edit handling**: last-write-wins. Optimistic locking and conflict detection are not part of this specification.
- The project object returned by the API includes the full Customer object (with address) nested for rendering convenience, even though the storage uses a foreign key reference (`customerId`). See [data-model.md §5.1](data-model.md#51-project-entity) and [§5.6](data-model.md#56-customer-entity).

#### 14.2.3 User Management

| Operation               | Input                                          | Output                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List users**          | optional: offset, limit                        | user list, total count | Returns all users (including deactivated). Requires `user:read` permission. `passwordHash` is never included in responses.                                                                                                                                                                                                                                                                                                  |
| **Get user**            | user ID                                        | single user            | Returns the full user object (minus `passwordHash`) or a not-found error. Requires `user:read` permission.                                                                                                                                                                                                                                                                                                                  |
| **Create user**         | username, displayName, password, roles, email? | created user           | Creates a new user account. `username` must be unique. Password must meet the configured password policy (see [index.md §4.5](index.md#45-authentication)). Requires `user:manage` permission.                                                                                                                                                                                                                              |
| **Update user**         | user ID, displayName?, roles?, email?          | updated user           | Updates the specified fields. PATCH semantics. Does **not** allow changing `username` (immutable after creation). Does **not** accept password changes (use Reset password or Change own password). Requires `user:manage` permission.                                                                                                                                                                                      |
| **Deactivate user**     | user ID                                        | updated user           | Sets `active = false`. Deactivation invalidates all sessions for the user. A deactivated user cannot log in. Requires `user:manage` permission. The acting user cannot deactivate themselves.                                                                                                                                                                                                                               |
| **Reactivate user**     | user ID                                        | updated user           | Sets `active = true`. Requires `user:manage` permission.                                                                                                                                                                                                                                                                                                                                                                    |
| **Reset password**      | user ID, new password                          | success/failure        | Administrative password reset — does not require the user's current password. New password must meet the configured password policy. Invalidates all sessions for the target user. Requires `user:manage` permission.                                                                                                                                                                                                       |
| **Change own password** | current password, new password                 | success/failure        | Any authenticated user can change their own password. Current password must be verified before accepting the change. New password must meet the configured password policy (see [index.md §4.5](index.md#45-authentication)). Success invalidates every **other** session for the same user (the current session survives); see [data-model.md §5.4](data-model.md#54-session). Requires `auth:change-password` permission. |

Design notes:

- Password fields are accepted as plaintext input over the API (over HTTPS). The server hashes them before storage. Plaintext passwords are never stored or logged.
- **Username is immutable** after creation — it serves as the login identifier and must remain stable.
- **Deactivation vs. deletion**: users are never deleted (see [data-model.md §6.9](data-model.md#69-soft-deletes)). Deactivation preserves referential integrity for historical project assignments and audit trails.
- **Self-deactivation is prohibited**: the acting user cannot deactivate their own account. This prevents accidental lockout.
- **Other-session invalidation** on password change is intentional: a compromised password that has already been used to open sessions on other devices must not survive a password rotation. Change-own-password preserves the current session; Reset password (admin action) invalidates all sessions for the target user.
- **Reset password vs. Change own password**: Reset password is an administrative action that does not require the target user's current password. Change own password is a self-service action that verifies the current password first.

#### 14.2.4 Bulk Operations

Bulk and export operations support data exchange with external systems. Import operations submit many items in a single request with partial-success semantics. Export operations return data in a portable format for downstream consumption (bookkeeping software, external reports, data migration).

Import operations follow a uniform shape: each item is validated independently, valid items are persisted, and the response reports both how many succeeded and which ones failed (with the index in the input array and a German error message).

| Operation                 | Input                                                                                                                                                                                                                                                    | Output                                                               | Notes                                                                                                                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bulk import projects**  | array of project items, each with the same fields as a single project (`number`, `title`, `customerId`, optional `status`, optional `plannedStart`/`plannedEnd`, optional `assignedWorkerIds` (user UUIDs), optional `estimatedValue`, optional `notes`) | `{ imported: number, errors: { index: number, message: string }[] }` | Each item is validated independently. The endpoint never aborts on the first invalid item — partial success is the expected outcome. Items with `status` omitted default to the first workflow state. `customerId` must reference an existing Customer. Requires the `project:create` permission. |
| **Bulk import customers** | array of customer items, each with: `name`, optional `phone`, `email`, `address`, `notes`                                                                                                                                                                | `{ imported: number, errors: { index: number, message: string }[] }` | Same partial-success semantics as project import. Customer names need not be unique — duplicates are allowed (common in real-world data from external systems). Requires `customer:write` permission.                                                                                             |
| **Export projects**       | optional: format (`json`), optional: filter (by status, by customerId, by date range)                                                                                                                                                                    | array of project objects (full shape including nested customer)      | Returns all non-deleted projects matching the filter criteria. Default format is JSON. Requires `project:read` permission.                                                                                                                                                                        |
| **Export customers**      | optional: format (`json`), optional: filter (has-projects, no-projects)                                                                                                                                                                                  | array of customer objects                                            | Returns all customers matching the filter criteria. Default format is JSON. Requires `customer:read` permission.                                                                                                                                                                                  |

Design notes:

- **Partial success is intentional.** A 30-row import where 2 rows are malformed should not block the other 28. The response gives the client enough information to render an error report and let the user fix the rejected rows.
- **Validation runs server-side.** The same shape rules used by single-project creation are applied per item. The validator must be a pure function so it can be reused client-side (e.g. for an import-preview UI) without round-tripping to the server.
- **No transactional all-or-nothing semantics.** If a row fails _after_ it passed validation (e.g., a row violates a uniqueness constraint such as a duplicate project number), the row is reported in `errors` and the others still commit. This matches the import-tool model the kickoff describes. Runtime errors from the database layer are translated to a generic German message before being packaged into the response — see [architecture.md §13.6](architecture.md#136-error-messages) — so that no column, table, or constraint name reaches the client.
- **Uniform result shape.** All bulk operations follow the same `{ imported|updated|... , errors }` pattern. The client can write a single `BulkResult` handler instead of one per operation.
- **Export operations** return the full entity shape as defined in the data model. No field omission or transformation is applied — the export is a faithful representation of the API resource. Sensitive fields (`passwordHash`) are excluded as they are never part of API responses.
- **Format extensibility**: the `format` parameter currently accepts only `json`. The parameter exists so that additional formats (e.g., CSV) can be added without changing the operation contract.
- **Filter parameters on exports** are optional. Without filters, the full dataset is returned. Filters use AND logic — multiple filters narrow the result set.

#### 14.2.5 Customer Management

All customer operations require an authenticated session.

| Operation           | Input                                                | Output                                         | Notes                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **List customers**  | optional: offset, limit, search (name substring)     | customer list, total count                     | Returns all customers. Search parameter filters by name (case-insensitive substring match).                                                                                    |
| **Get customer**    | customer ID                                          | single customer, with associated project count | Returns the full customer object or a not-found error. Includes a count of projects referencing this customer.                                                                 |
| **Create customer** | name, phone?, email?, address?, notes?               | created customer                               | Creates a new customer. `name` is required. Requires `customer:write` permission.                                                                                              |
| **Update customer** | customer ID, name?, phone?, email?, address?, notes? | updated customer                               | Updates the specified fields. PATCH semantics — omitted fields are unchanged. Explicitly passing `null` for an optional field clears it. Requires `customer:write` permission. |

Design notes:

- No delete operation. Customers with projects cannot be deleted (FK constraint). All customer records are permanent.
- The search parameter on list is a convenience for the UI — a name-based lookup is the most common customer search pattern.
- Creating or updating a customer does not affect any associated projects beyond the FK reference.

---

### 14.3 Authorization Rules

- All API operations require authentication (valid, active session).
- The system implements a basic role-based permission matrix. All authenticated, active users can view all projects (list, get) and change their own password. Other operations — including mutations, imports, and exports — require specific permissions granted by role:

| Role       | Permissions                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| owner      | project:read, project:transition, project:dates, project:create, project:update, project:delete, customer:read, customer:write, user:read, user:manage, auth:change-password |
| office     | project:read, project:transition, project:dates, project:create, project:update, project:delete, customer:read, customer:write, user:read, auth:change-password              |
| worker     | project:read, customer:read, auth:change-password                                                                                                                            |
| bookkeeper | project:read, customer:read, auth:change-password                                                                                                                            |

Design notes:

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

| Category                 | Meaning                                                                                                                    | Client behavior                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Authentication error** | Credentials invalid, session expired, or session absent.                                                                   | Redirect to login screen. Show expiry message if session was previously valid. |
| **Authorization error**  | User is authenticated but lacks permission for the requested operation (e.g., changing another user's password).           | Show error message. Do not redirect to login.                                  |
| **Validation error**     | Request is malformed or violates business rules (e.g., transition from `erledigt`, missing required field, invalid dates). | Show error message. Revert optimistic update if applicable.                    |
| **Not found**            | The requested entity (project or user ID) does not exist.                                                                  | Show error message. Re-fetch project list to sync state.                       |
| **Server error**         | Unexpected internal failure.                                                                                               | Show generic error message. Do not expose internal details.                    |
| **Rate limited**         | Too many requests in the configured time window.                                                                           | Show retry message. Back off before retrying.                                  |

The full set of machine-readable error codes: `INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `SESSION_EXPIRED`, `NOT_PERMITTED`, `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `SERVER_ERROR`.

#### 14.4.2 Error Principles

- **Authentication errors are distinguishable from authorization errors.** An expired session must not produce the same error as an insufficient permission — the client handles them differently (redirect vs. inline message).
- **Validation errors are structured.** When a mutation is rejected for business rule violations, the error must identify which rule was violated (e.g., "cannot transition from terminal state") so the client can render a meaningful message.
- **Error messages never leak internal details.** No stack traces, database field names, table names, file paths, or query information in any error response. This applies to all error categories including server errors.

---

_Cross-references: [index.md](index.md) for scope and assumptions, [data-model.md](data-model.md) for entity definitions, [ui.md](ui.md) for client-side behavior that consumes this API, [architecture.md](architecture.md) for responsibility layers and security requirements, [verification.md](verification.md) for acceptance criteria and API integration tests._
