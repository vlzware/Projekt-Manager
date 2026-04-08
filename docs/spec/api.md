# API Specification

*Iteration 4 — April 2026 | Living document — updated as each iteration ships.*

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

#### 14.2.1 Authentication

| Operation | Input | Output | Notes |
|---|---|---|---|
| **Login** | username, password | session token, user profile (id, username, displayName, roles, email) | Creates a new session. Rejects inactive users (`active = false`). |
| **Logout** | session token | -- | Invalidates the specific session, not all sessions for the user. |
| **Get current user** | (session) | user profile (id, username, displayName, roles, email) | Returns the authenticated user's profile. Used on app load to restore session (see [ui.md — Authentication Behavior](ui.md#94-authentication-behavior)). |

Design notes:

- Failed login returns a generic error — no distinction between "user not found" and "wrong password" to avoid information leakage. The error message is suitable for display on the login screen.
- The user profile returned by Login and Get current user never includes `passwordHash` (see [data-model.md — User Entity](data-model.md#53-user-entity)).
- Get current user allows the client to check on app load whether an existing session is still valid without requiring a fresh login.
- Session duration and token format are implementation decisions (ADR territory).

#### 14.2.2 Projects

All project operations require an authenticated session.

| Operation | Input | Output | Notes |
|---|---|---|---|
| **List projects** | optional: offset, limit | project list, total count | Returns all projects visible to the authenticated user. Pagination optional for this iteration's data volume but the contract must support it. |
| **Get project** | project ID | single project | Returns the full project object or a not-found error. |
| **Transition forward** | project ID | updated project | Advances status by one step. Rejects if current state is `erledigt`. Sets `status`, `statusChangedAt`, `updatedAt`, and `updatedBy` server-side. |
| **Transition backward** | project ID | updated project | Moves status back by one step. Rejects if current state is `anfrage` or `erledigt`. Sets `status`, `statusChangedAt`, `updatedAt`, and `updatedBy` server-side. |
| **Update dates** | project ID, plannedStart?, plannedEnd? | updated project | Updates date fields. Sets `updatedAt` and `updatedBy` server-side. Does **not** modify `statusChangedAt` — date changes must not reset aging calculations. |

Design notes:

- **Transitions are explicit operations**, not generic field updates. This preserves the workflow rule that only adjacent states are reachable (see [ui.md — State Transitions](ui.md#91-state-transitions)) and makes the business rule enforceable server-side.
- **No create or delete operations** in this iteration (see [index.md — Scope](index.md#22-out-of-scope)).
- **Full project object returned** after every mutation so the client can update its local state without a separate fetch.
- **Concurrent edit handling** (e.g., optimistic locking) is deferred. At current scale (1–5 users), last-write-wins is acceptable. A future iteration may introduce conflict detection when multi-user editing becomes frequent.
- The project object returned by the API uses the shape defined in [data-model.md — Project Entity](data-model.md#51-project-entity), including nested `customer` and `address` objects.

#### 14.2.3 User Management

| Operation | Input | Output | Notes |
|---|---|---|---|
| **Change own password** | current password, new password | success/failure | Any authenticated user can change their own password. Current password must be verified before accepting the change. New password must meet the configured password policy (see [index.md §4.5](index.md#45-authentication)). |

Other user management operations (list, create, update, reset password) are deferred to the iteration that introduces the administrator UI. Until then, user administration is handled via seed data or direct database access.

Design notes:

- Password fields are accepted as plaintext input over the API (over HTTPS). The server hashes them before storage. Plaintext passwords are never stored or logged.
- The change-password operation is API-only in this iteration — there is no UI surface for it. A "Passwort ändern" entry in the user dropdown is planned for a future iteration.

#### 14.2.4 Bulk Operations

Bulk operations let an administrator (or import flow) submit many items in a single request. They follow a uniform shape: each item is validated independently, valid items are persisted, and the response reports both how many succeeded and which ones failed (with the index in the input array and a German error message).

| Operation | Input | Output | Notes |
|---|---|---|---|
| **Bulk import projects** | array of project items, each with the same fields as a single project (`number`, `title`, `customer`, optional `address`, optional `status`, optional `plannedStart`/`plannedEnd`, optional `assignedWorkers`, optional `estimatedValue`, optional `notes`) | `{ imported: number, errors: { index: number, message: string }[] }` | Each item is validated independently. The endpoint never aborts on the first invalid item — partial success is the expected outcome. Items with `status` omitted default to the first workflow state. Requires the `project:create` permission. |

Design notes:

- **Partial success is intentional.** A 30-row import where 2 rows are malformed should not block the other 28. The response gives the client enough information to render an error report and let the user fix the rejected rows.
- **Validation runs server-side.** The same shape rules used by single-project creation are applied per item. The validator is a pure function so it can also be reused client-side for an "import preview" UI in a future iteration without round-tripping to the server.
- **No transactional all-or-nothing semantics.** If a row fails *after* it passed validation (e.g., a unique-key conflict on `number`), the row is reported in `errors` and the others still commit. This matches the import-tool model the kickoff describes.
- **The shape generalizes.** Future bulk operations (bulk update, bulk transition, bulk delete, bulk customer import) follow the same `{ imported|updated|... , errors }` pattern. The client can write a single `BulkResult` handler instead of one per operation.

---

### 14.3 Authorization Rules

- All API operations require authentication (valid, active session).
- User management (change own password) requires the authenticated user to be changing their own password.
- No role-based restrictions on project operations in this iteration. All authenticated, active users can view all projects and perform transitions and date changes.

The authorization model is minimal by design. Future iterations will introduce role-based access control; the implementation should use a centralized auth check that can be extended, not scattered per-route checks.

Design notes:

- When role-specific views are introduced (later iterations), read access may be scoped (e.g., a worker sees only assigned projects). The API must be designed so that adding query filters (e.g., "projects assigned to user X") does not require restructuring — it should be an additive parameter on the list operation.
- Authorization checks must be enforced server-side. Client-side UI hiding (e.g., hidden buttons) is a UX convenience, not a security measure (see [architecture.md §13.6](architecture.md#136-security)).

---

### 14.4 Error Handling

Every error response carries two components:

| Component | Purpose | Example |
|---|---|---|
| **Machine-readable code** | Programmatic handling by the client | `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `NOT_PERMITTED` |
| **Human-readable message** | Display to the user (German, **[C]**) | `"Anmeldung fehlgeschlagen"`, `"Sitzung abgelaufen"` |

#### 14.4.1 Error Categories

The API must distinguish the following error categories. Each category has distinct client-side handling (see [ui.md — Asynchronous Mutation Behavior](ui.md#95-asynchronous-mutation-behavior)).

| Category | Meaning | Client behavior |
|---|---|---|
| **Authentication error** | Credentials invalid, session expired, or session absent. | Redirect to login screen. Show expiry message if session was previously valid. |
| **Authorization error** | User is authenticated but lacks permission for the requested operation (e.g., changing another user's password). | Show error message. Do not redirect to login. |
| **Validation error** | Request is malformed or violates business rules (e.g., transition from `erledigt`, missing required field, invalid dates). | Show error message. Revert optimistic update if applicable. |
| **Not found** | The requested entity (project or user ID) does not exist. | Show error message. Re-fetch project list to sync state. |
| **Server error** | Unexpected internal failure. | Show generic error message. Do not expose internal details. |

#### 14.4.2 Error Principles

- **Authentication errors are distinguishable from authorization errors.** An expired session must not produce the same error as an insufficient permission — the client handles them differently (redirect vs. inline message).
- **Validation errors are structured.** When a mutation is rejected for business rule violations, the error must identify which rule was violated (e.g., "cannot transition from terminal state") so the client can render a meaningful message.
- **Error messages never leak internal details.** No stack traces, database field names, table names, file paths, or query information in any error response. This applies to all error categories including server errors.

---

*Cross-references: [index.md](index.md) for scope and assumptions, [data-model.md](data-model.md) for entity definitions, [ui.md](ui.md) for client-side behavior that consumes this API, [architecture.md](architecture.md) for responsibility layers and security requirements, [verification.md](verification.md) for acceptance criteria and API integration tests.*
