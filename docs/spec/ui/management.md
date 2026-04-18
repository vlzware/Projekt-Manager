# UI: Management Views

Section 8.8–8.10 of the [product spec](../index.md) — the tabular CRUD surfaces for Projects, Customers, and Users. Email Data Intake (§8.12) — a modal customer+project creation flow entered from a header button — is a sibling page at [email-intake.md](email-intake.md). Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules (in-flight lock, error handling, mutation semantics) in [behavior.md](behavior.md).

---

## 8.8 Project Management View

A tabular list of all projects with search, filtering, and CRUD operations.

### 8.8.1 List

- Columns: project number, title, customer name, status (colored badge), planned dates, estimated value, assigned workers.
- Sortable by any column. Default sort: project number descending.
- Search: free-text filter across project number, title, and customer name.
- Filters: by status (multi-select), by customer, by date range (planned start), by "has no dates" flag, by archive inclusion (`Archivierte einblenden` toggle, off by default). Filters use AND logic. A "Filter aufheben" control clears all filters.
- Pagination when the list exceeds a configurable page size **[C]**.
- Soft-deleted (archived) projects are excluded by default; the `Archivierte einblenden` toggle includes them. Archived rows are visually distinguished (muted text, `Archiviert` badge).

### 8.8.2 Create Project

Accessible via a primary action button. Requires `project:create` permission (button hidden otherwise).

Fields:

- **Project number** — auto-suggested from the configured format **[C]**, editable by the user, immutable after creation. On blur, the field shows a green "available" indicator if the number is free and a red "taken" indicator if an existing project already uses it. The indicator is UX feedback only — the server's uniqueness constraint is authoritative (see [api.md §14.2.2](../api.md#1422-projects)) and is what ultimately produces or rejects the create. Editing the field after a verdict clears the indicator until the next blur.
- **Title** — required.
- **Customer** — required. Selection from existing customers, with an option to create a new customer inline (see [§8.9.4](#894-inline-customer-creation)).
- **Status** — defaults to the first workflow state. Optionally selectable if configuration allows **[C]**.
- **Planned start / Planned end** — optional. Same validation as the detail panel (end requires start).
- **Assigned workers** — optional multi-select from active users with the `worker` role.
- **Estimated value** — optional numeric input.
- **Notes** — optional free text.

On success, the new project appears in the list and in Kanban/Calendar views.

**In-flight mutation lock** and **idempotency-conflict recovery** apply as defined in [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior).

### 8.8.3 Edit Project

Clicking a project row opens the project for editing. The editing surface reuses the Project Detail Panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)) with expanded editability:

- **Planned start / Planned end** — editable via date inputs. Same validation as the detail panel (end requires start, end disabled when start is empty).
- **Notes** are editable.
- **Assigned workers** are editable via multi-select.
- **Estimated value** is editable.
- **Customer** can be changed.

All editable fields use PATCH semantics via the Update project API operation. Status changes use their dedicated transition operations. Date changes use the dedicated update-dates operation (see [api.md §14.2.2](../api.md#1422-projects)).

Requires `project:update` permission for mutations. Users without this permission see all fields as read-only.

### 8.8.4 Archive Project

Available per project row or in the edit view. The action is labelled "Archivieren". Confirmation dialog: `"Projekt {number} wirklich archivieren?"` with OK / Abbrechen. The API call soft-deletes the project (see [api.md §14.2.2](../api.md#1422-projects) and [ADR-0017](../../adr/0017-soft-delete-as-board-archive.md)).

Requires `project:delete` permission.

### 8.8.5 Permanently delete project

A secondary action labelled `Endgültig löschen` on archived project rows. Hard-deletes the project via `DELETE /api/projects/:id/purge` (see [api.md §14.2.2](../api.md#1422-projects)).

Visibility: the action appears only when the row has `deleted = true` AND the `Archivierte einblenden` toggle is on AND the caller holds `project:purge`. Hidden in every other case (consistent with [AC-121](../verification.md#1516-management-views)).

Confirmation dialog: simple Yes / No with a German warning that states the project will be permanently deleted and recovery is not possible. The archive-first gate on the API (a non-archived project is rejected with 409) is the primary friction; the confirmation is the secondary check.

Permission: requires `project:purge` (owner-only per the permission matrix in [api.md §14.3](../api.md#143-authorization-rules)). The button is not rendered for users without it. Server-side authorization is authoritative.

See [ADR-0017](../../adr/0017-soft-delete-as-board-archive.md) for the trash-bin rationale (archive-first, purge as the second step).

---

## 8.9 Customer Management View

A tabular list of all customers with search and CRUD operations.

### 8.9.1 List

- Columns: name, phone, email, city, project count, last updated.
- Search: name substring filter (case-insensitive), matching the API's `search` parameter.
- Pagination when the list exceeds a configurable page size **[C]**.
- Clicking a customer's project count navigates to the Project Management View filtered to that customer.

### 8.9.2 Create Customer

Accessible via a primary action button. Requires `customer:write` permission.

Fields:

- **Name** — required.
- **Phone** — optional.
- **Email** — optional.
- **Address** — optional nested group: street, zip, city.
- **Notes** — optional free text.

**Duplicate-name suggestions (as-you-type).** While the user types in the name field, the form runs a debounced search against the customer list and presents matching customers in a dropdown below the input. Clicking a suggested customer closes the create form and opens that customer's edit form. The dropdown is an advisory hint — the user may ignore it and continue creating a new customer.

**Soft confirm on exact-name match.** On submit, if any existing customer's name matches the entered name (case-insensitive, whitespace-normalized), a confirmation dialog appears before the create is dispatched. The user must explicitly opt in via "Trotzdem erstellen" to proceed; cancelling returns to the form without sending a request. Creating legitimate duplicates is allowed — the confirm is a guard against accidental ones.

On success, the new customer appears in the list and is immediately available in project creation/editing dropdowns.

**In-flight mutation lock.** See [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior). The lock covers the soft-confirm dialog — submitting once while the confirm is open does not permit a second submit to fire through.

**Idempotency-conflict recovery.** A rare server-side conflict (see [api.md §14.4](../api.md#144-error-handling)) closes the create form, refreshes the customer list, and surfaces the German error message via the mutation error banner ([index.md §8.1.2](index.md#812-authenticated-state)). The user is not invited to retry the same submission.

### 8.9.3 Edit Customer

Clicking a customer row opens the customer for editing. PATCH semantics: omitted fields unchanged, explicit `null` clears optional fields.

Requires `customer:write` permission for mutations. Users without this permission see all fields as read-only.

### 8.9.4 Inline Customer Creation

When creating or editing a project ([§8.8.2](#882-create-project), [§8.8.3](#883-edit-project)), the customer selector includes an option to create a new customer inline. On successful creation, the new customer is automatically selected for the project.

### 8.9.5 Delete Customer

Available per customer row or in the edit view. Requires `customer:delete` permission (button hidden otherwise).

The confirmation dialog text depends on `archivedProjectCount` returned by `GET /api/customers/:id` (see [api.md §14.2.5](../api.md#1425-customer-management)):

- When `archivedProjectCount` is 0, the standard confirmation phrasing applies.
- When `archivedProjectCount > 0`, the confirmation surfaces a German warning that names the count and informs the user that those archived projects will be permanently deleted together with the customer.

Deletion of a customer that still has active (non-archived) projects is rejected as a conflict by the API — the UI surfaces the German error message via the mutation error banner. See [ADR-0017](../../adr/0017-soft-delete-as-board-archive.md) for the archive-vs-purge boundary.

---

## 8.10 User Management View

An administrative view for managing user accounts. Only accessible to users with `user:manage` permission (owner only under the default role set — matches the nav matrix in [index.md §8.7.1](index.md#871-views)). Hidden from navigation for users without this permission. Office and other roles that hold only `user:read` (for dropdown lookups, not administration) are not admitted — server-side listing via `GET /api/users` remains gated on `user:read` independently.

### 8.10.1 List

- Columns: display name, username, roles (as badges), email, active status indicator, last login.
- Shows all users including deactivated ones. Deactivated users are visually distinct.

### 8.10.2 Create User

Accessible via a primary action button. Requires `user:manage` permission (button hidden otherwise).

Fields:

- **Username** — required, unique, immutable after creation.
- **Display name** — required.
- **Password** — required. Must meet the configured password policy **[C]**. Includes a confirmation field; submission is blocked until both entries match.
- **Roles** — required. Multi-select from the configured role set **[C]**.
- **Email** — optional.

### 8.10.3 Edit User

Clicking a user row opens the user for editing. Editable fields: display name, roles, email. Username is read-only.

Password is not part of the edit form — password reset uses a dedicated operation ([§8.10.5](#8105-reset-password)).

Requires `user:manage` permission for mutations.

### 8.10.4 Deactivate / Reactivate

Available as a row action or within the edit view. Requires `user:manage` permission.

- **Deactivate**: confirmation dialog. Self-deactivation is rejected by the API; the UI should prevent it.
- **Reactivate**: confirmation dialog.

### 8.10.5 Reset Password

Available as a row action or within the edit view. Opens a form with new password plus confirmation. Must meet the configured password policy.

Administrative action — does not require the target user's current password. Invalidates all of the target user's sessions.

Requires `user:manage` permission.

### 8.10.6 Delete User

Available within the user detail view. Confirmation dialog. Self-deletion is prevented (button hidden for the authenticated user's own record; API rejects if attempted). Hard-deletes the user and cascades related data (sessions, worker assignments).

Requires `user:delete` permission (owner only).
