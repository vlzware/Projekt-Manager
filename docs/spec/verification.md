# Verification

---

## 15. Acceptance Criteria

The system is accepted when all of the following are true.

Every criterion carries exactly one tier marker:

- **`[crit]`** — **Critical**: a defect means data corruption, financial impact, authentication/authorization failure, data integrity violation, or misleading state that causes wrong user decisions. Verified by automated test. The method matches the contract's surface — unit, integration, E2E or a mix thereof.
- **`[vis]`** — **Visual / Design**: specifies expected behavior that does not guard a critical path. Verified by structural E2E as well as regular human review.
- **`[infra]`** — **Infrastructure / Structural**: a constraint on the deployed environment, the build pipeline, or the source-tree organization. Verified by deployment procedures, CI gates, lint, or code review — not by tests against the running system.

### 15.1 Core

- **AC-1** `[vis]`: The full stack (frontend, backend, database) starts locally with a documented command or minimal command sequence.
- **AC-2** `[vis]`: Kanban view renders 9 columns with all projects in their correct states.
- **AC-3** `[vis]`: Calendar view renders projects with planned dates as colored bars on a month grid.
- **AC-4** `[vis]`: Clicking a project in either view opens the detail panel with all available fields.
- **AC-5** `[crit]`: The [→] button transitions a project to the next state, with a German confirmation dialog. The card moves to the correct column. The change persists across page reloads.
- **AC-6** `[crit]`: Backward transition via the detail panel moves a project to the previous state. The change persists across page reloads.
- **AC-7** `[crit]`: Changing a date in the detail panel updates `plannedStart`/`plannedEnd` and is reflected in both views. The change persists across page reloads.
- **AC-8** `[vis]`: Summary area shows counts for action states and aged buffer items.
- **AC-9** `[vis]`: Clicking a summary indicator from any view switches to the Kanban view and applies the filter to affected projects. Clicking the same active indicator clears the filter without navigating.
- **AC-10** `[vis]`: "X Projekte ohne Termin" counter appears below the calendar.

### 15.2 Visual

- **AC-11** `[vis]`: Action columns are visually distinct from buffer columns.
- **AC-12** `[vis]`: Each state has a consistent color across Kanban dots, calendar bars, and detail badge.
- **AC-13** `[vis]`: Aged buffer items show a `"seit X Tagen"` indicator.
- **AC-14** `[vis]`: Cards display project number, title, customer, dates (or "Kein Termin").
- **AC-15** `[vis]`: Every card shows its `statusChangedAt` date. The date turns bold when the configured aging threshold is exceeded.

### 15.3 Behavioral

- **AC-16** `[crit]`: State transitions only allow forward +1 or backward -1. No skipping.
- **AC-17** `[crit]`: `Erledigt` is terminal — both transition buttons are hidden.
- **AC-18** `[crit]`: `Anfrage` hides the backward transition button.
- **AC-19** `[vis]`: Display dates use German format (DD.MM.YYYY). Date input controls respect the user's browser locale. Calendar week starts Monday.
- **AC-20** `[vis]`: Kanban, Calendar, and the Project Detail Panel render without errors when `customer`, `plannedStart`, `plannedEnd`, `notes`, `assignedWorkers`, or `estimatedValue` are absent.
- **AC-53** `[crit]`: A failed mutation displays a German error message and reverts the optimistic UI update.
- **AC-122** `[vis]`: Modals close on Escape (except while a mutation is in flight, see [AC-131](#153-behavioral)). Form modals submit the primary action on Enter when focus is within the form. Read-only modals accept Escape but do not submit on Enter.
- **AC-123** `[vis]`: Form modals and confirmation dialogs do not close on backdrop click — only via Escape or the explicit cancel action. Non-editing side panels close on backdrop click.
- **AC-131** `[crit]`: While a create, edit, or state-changing mutation is in flight, the form's submit action is disabled, every input in the form is disabled, and the enclosing modal cannot be closed (Escape, close button, backdrop). The lock covers any user-confirmation dialog that precedes request dispatch, so a submit initiated behind an open confirm does not fire a second time. The lock releases when the request resolves (success or failure). Rationale: silent double-dispatch or a close-during-flight produces state the user did not intend — a misleading-state class defect.

### 15.4 Authentication

- **AC-21** `[crit]`: Unauthenticated users see only a login screen. No project data is accessible.
- **AC-22** `[crit]`: Entering valid credentials and clicking "Anmelden" logs the user in and shows the Kanban view.
- **AC-23** `[crit]`: Entering invalid credentials shows a generic error message in German.
- **AC-24** `[vis]`: The user's display name is shown in the header.
- **AC-25** `[crit]`: Clicking "Abmelden" logs the user out and returns to the login screen.
- **AC-26** `[crit]`: After logout, pressing the browser back button does not reveal project data.
- **AC-27** `[crit]`: A session that expires while the app is open redirects to login with an expiry message.
- **AC-28** `[crit]`: A request with a valid session token for a deactivated user is rejected with an authentication error.
- **AC-52** `[crit]`: An authenticated user can change their own password. A change attempt with an incorrect current password is rejected.

### 15.5 Multi-User

- **AC-29** `[crit]`: Two users logged in simultaneously see each other's changes after refreshing.

### 15.6 Deployment

- **AC-30** `[infra]`: The application is reachable by authorized clients over HTTPS. HTTPS is required by default; the only documented exception is the guarded evaluation mode (see AC-45). Network reachability is scoped by [ADR-0008](../adr/0008-vpn-first-network-access.md); see also AC-49.
- **AC-31** `[infra]`: A CI-built image can be promoted to the hosted environment via manual, pull-based deploy over VPN (see [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)).
- **AC-45** `[crit]`: HTTPS is enforced by default. HTTP-only mode requires an explicit opt-in flag AND a non-production environment (neither alone is sufficient). When HTTP mode is active, the UI shows a non-dismissible warning banner on every page. Enabling the insecure flag in production causes the server to refuse to start. See [ADR-0013](../adr/0013-http-only-evaluation-mode.md).
- **AC-46** `[infra]`: A failed deployment leaves the previously running version running.
- **AC-47** `[infra]`: A previously deployed commit can be redeployed (rollback) by the operator over VPN. See [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md).
- **AC-48** `[infra]`: After every deploy, an automated smoke test verifies the health endpoint. Failure aborts the deploy.
- **AC-49** `[infra]`: The hosted environment is reachable only via VPN. See [ADR-0008](../adr/0008-vpn-first-network-access.md).
- **AC-50** `[infra]`: Database and object storage data persist across container restarts and redeploys.
- **AC-51** `[infra]`: Deployments use a specific commit SHA, not a moving tag.

### 15.7 Engineering

- **AC-32** `[infra]`: Code structure and dependency direction follow [architecture.md §11.2](architecture.md#112-responsibility-boundaries). No reverse imports.
- **AC-33** `[infra]`: Mutation boundary per [architecture.md §11.1](architecture.md#111-mandatory-constraints) is enforced. UI components dispatch through the state layer, not directly to the API client.
- **AC-34** `[infra]`: State configuration (labels, colors, thresholds) is centralized, not scattered.
- **AC-35** `[infra]`: Dependency direction is enforced by linter import restriction zones.
- **AC-36** `[infra]`: Linting and formatting pass.
- **AC-37** `[infra]`: Tests defined in section 16 pass. Push/PR gate runs unit, component, and API integration tests. E2E tests run on-demand (see [architecture.md §11.7](architecture.md#117-continuous-delivery-pipeline)).

### 15.8 Configurability

- **AC-38** `[vis]`: App name (header) and footer text are driven by a branding config, not hardcoded in components. Changing the config changes all instances.
- **AC-39** `[crit]`: Authentication parameters (session duration) are driven by configuration.

### 15.9 Infrastructure

- **AC-40** `[crit]`: Object storage module successfully uploads and retrieves a file in the deployed environment (see [architecture.md §11.4](architecture.md#114-object-storage-module)).
- **AC-132** `[crit]`: The server runs a periodic job that deletes expired sessions (sessions past their `expiresAt`, see [data-model.md §5.4](data-model.md#54-session)). An in-flight sweep is drained on graceful shutdown before the database pool closes. Rationale: unbounded growth of expired session rows degrades auth-check performance and is an operational data-integrity concern.

### 15.10 Responsive

- **AC-41** `[vis]`: At viewport widths below 1780px, tier-3 columns (Angebot, Abgerechnet, Erledigt) collapse to slim indicators showing the column header and card count. Cards are hidden.
- **AC-42** `[vis]`: At viewport widths below 1350px, tier-2 columns (Geplant, In Arbeit, Abnahme) also collapse.
- **AC-43** `[vis]`: At viewport widths below 940px, tier-1 columns (Anfrage, Beauftragt, Rechnung fällig) also collapse. Action columns are always the last to collapse.
- **AC-44** `[vis]`: Clicking a collapsed column expands it. Clicking the column header again collapses it.

### 15.11 Customer Management

- **AC-54** `[crit]`: Creating a customer with a name returns a customer object with a generated ID. Phone, email, address, and notes are optional.
- **AC-55** `[crit]`: Updating a customer changes only the specified fields (PATCH semantics). Passing `null` clears an optional field.
- **AC-56** `[crit]`: Listing customers returns all customers with pagination support. The `search` parameter filters by name (case-insensitive substring match).
- **AC-57** `[crit]`: Getting a customer returns the full customer object and a count of associated projects.
- **AC-58** `[crit]`: A project references a customer via `customerId`. The API returns the full customer object nested in project responses.
- **AC-91** `[crit]`: Deleting a customer with no active projects succeeds (hard delete). Any archived projects are purged atomically with the customer. The customer no longer appears in list or get responses.
- **AC-92** `[crit]`: Deleting a customer that has active (non-archived) projects is rejected as a conflict (per the conflict error category in [api.md §14.4.1](api.md#1441-error-categories)). The customer and its projects remain unchanged.
- **AC-93** `[crit]`: Deleting a customer requires `customer:delete` permission. Users without this permission receive an authorization error.
- **AC-154** `[crit]`: The customer-delete confirmation dialog displays a German warning that names the archived-project count when `archivedProjectCount > 0` (sourced from `GET /api/customers/:id`). When the count is 0, the standard confirmation text is used. Rationale: the warning prevents silent destructive data loss — deleting a customer atomically purges all their archived projects (see [AC-91](#1511-customer-management) and [ADR-0017](../adr/0017-soft-delete-as-board-archive.md)).
- **AC-124** `[crit]`: Creating a customer with a client-supplied `id` persists the row under that id. Replaying the same request (same id, same user-supplied fields) returns the existing row with no duplicate persisted. A concurrent replay of the same id and body results in one insert and one replay, never two rows. See [api.md §14.2.5](api.md#1425-customer-management) for the field-comparison rule.

### 15.12 Project Management

- **AC-59** `[crit]`: Creating a single project with `number`, `title`, and `customerId` returns a project in the first workflow state. Optional fields default appropriately.
- **AC-60** `[crit]`: Updating a project changes the specified fields. Status and project number are not changeable via update (status uses transitions; number is immutable).
- **AC-61** `[crit]`: Soft-deleting a project marks it as deleted. The project no longer appears in list results, views, or exports.
- **AC-62** `[crit]`: Project number is unique. Creating a project whose `number` collides with an existing project is rejected with status 409 and error code `CONFLICT`. The German error message names the conflicting number. Distinct from the `IDEMPOTENCY_CONFLICT` path in [AC-127](#1517-data-integrity).
- **AC-125** `[crit]`: Creating a project with a client-supplied `id` persists the row under that id. Replaying the same request (same id, same body) returns the existing row with no duplicate persisted. A concurrent replay of the same id and body results in one insert and one replay, never two rows. See [api.md §14.2.2](api.md#1422-projects) for the field-comparison rule.
- **AC-151** `[crit]`: `GET /api/projects` accepts an `includeArchived` query parameter (boolean, default false). When false or omitted, the result excludes soft-deleted (`deleted = true`) rows. When true, the result includes them with their archive state preserved. The parameter AND-composes with the other filters (see [api.md §14.2.2](api.md#1422-projects)). Rationale: the default-safe boundary prevents leaking archived rows into contexts that expect active-only (misleading state).
- **AC-155** `[crit]`: `DELETE /api/projects/:id/purge` hard-deletes a project that is already archived (`deleted = true`). Assigned-worker rows (`project_workers`) are removed via cascade. The row is absent from subsequent list and get responses (including `includeArchived=true`). See [ADR-0017](../adr/0017-soft-delete-as-board-archive.md).
- **AC-156** `[crit]`: `DELETE /api/projects/:id/purge` on a non-archived project is rejected with 409 Conflict (per the conflict error category in [api.md §14.4.1](api.md#1441-error-categories)). The project is unchanged. The German error message directs the user to archive the project first.
- **AC-157** `[crit]`: `DELETE /api/projects/:id/purge` requires the `project:purge` permission. Callers without it receive 403 `NOT_PERMITTED`. The existing `project:delete` permission is not sufficient — purge is a narrower, strictly more destructive operation.
- **AC-158** `[crit]`: `DELETE /api/projects/:id/purge` on a non-existent project ID returns 404 (standard not-found contract).

### 15.13 User Management

- **AC-63** `[crit]`: An owner can create a new user account with username, display name, password, and roles. The created user can log in with the provided credentials.
- **AC-64** `[crit]`: An owner can update a user's display name, roles, and email. Username is immutable — attempts to change it are rejected.
- **AC-65** `[crit]`: An owner can deactivate a user. Deactivation invalidates all sessions for that user. The deactivated user cannot log in.
- **AC-66** `[crit]`: An owner can reactivate a previously deactivated user. The reactivated user can log in again.
- **AC-67** `[crit]`: An owner can reset another user's password. The new password must meet the password policy. The operation invalidates all sessions for the target user.
- **AC-68** `[crit]`: A user cannot deactivate themselves. The API rejects self-deactivation with an error.
- **AC-69** `[crit]`: Only users with `user:manage` permission (owner role) can create, update, deactivate, reactivate, or reset passwords. Other roles receive an authorization error.

### 15.14 Data Exchange

- **AC-133** `[crit]`: The unified export rejects unauthenticated requests and requests from users without `data:export` with an authorization error.
- **AC-134** `[crit]`: The unified import rejects unauthenticated requests and requests from users without `data:restore` with an authorization error.
- **AC-135** `[crit]`: The export envelope contains `schema_version`, `exported_at`, and all customers, projects, and project-worker assignments, including archived (soft-deleted) rows with archive state preserved.
- **AC-136** `[crit]`: An import whose envelope `schema_version` does not equal the current one is rejected with a specific error code and performs no writes.
- **AC-137** `[crit]`: An import into an empty database succeeds, preserves IDs exactly, and runs as a single transaction (all-or-nothing).
- **AC-138** `[crit]`: An import into a non-empty database is rejected unless the override flag is set in the request.
- **AC-139** `[crit]`: An import with the override flag into a non-empty database wipes existing business data and restores atomically. If any row fails validation, no state change is persisted.
- **AC-140** `[crit]`: A dry-run import performs full validation, returns a preview, and makes no writes. Subsequent reads show no state change.
- **AC-141** `[crit]`: A full roundtrip — seed → export → wipe → import → export — produces byte-identical export output. Verified in CI on every build.
- **AC-142** `[vis]`: The Daten navigation tab is hidden for users without `data:export`. Specialization of [AC-121](#1516-management-views) for this tab.
- **AC-143** `[vis]`: The unified restore UI runs a dry-run and presents the resulting preview before the commit action is enabled.
- **AC-144** `[vis]`: The unified export UI offers a single "Herunterladen" action that produces the unified JSON file. The filename includes a timestamp.
- **AC-160** `[crit]`: `POST /api/import?override=true` into a non-empty database requires a `confirmation_phrase` field in the request body matching the configured phrase **[C]**. A missing or non-matching phrase is rejected with error code `RESTORE_CONFIRMATION_MISMATCH` and performs no writes. Dry-run requests and override-into-empty-target requests are exempt. Comparison is case-sensitive after trimming leading/trailing whitespace.
- **AC-161** `[vis]`: The restore UI renders a destructive-action confirmation input only when the dry-run preview indicates the target database is non-empty. The commit action stays disabled until the typed value matches the configured phrase **[C]**. Client-side disabling is a UX affordance; the server remains authoritative (see [AC-160](#1514-data-exchange)).
- **AC-162a** `[crit]`: On the commit path, `POST /api/import` rejects an envelope whose user-id references (`customers.createdBy`, `customers.updatedBy`, `projects.createdBy`, `projects.updatedBy`, `project_workers.userId`) point to users absent from the target database. The response is HTTP 422 with error code `MISSING_USER_REFS`. `details.missingUserIds` is the deduplicated list of absent user ids; `details.references` carries one `{ path, userId }` entry per offending envelope reference site (duplicates across sites produce duplicate entries). Null or missing audit-field values do not trigger the code. No writes are persisted; atomicity with the wipe phase when `override=true` is already covered by [AC-139](#1514-data-exchange) (and [AC-137](#1514-data-exchange) for the single-transaction guarantee). See [api.md §14.2.4](api.md#1424-unified-data-exchange) and [api.md §14.4.1](api.md#1441-error-categories).
- **AC-162b** `[crit]`: On the dry-run path (`dry_run=true`), missing-user-reference issues and intra-envelope issues are both evaluated regardless of intra-envelope state and surfaced together in the preview. The gate that restricts the missing-user check to intra-consistent envelopes applies only to the commit path. No writes occur on dry-run. See [api.md §14.2.4](api.md#1424-unified-data-exchange).
- **AC-162c** `[crit]`: On the commit path, intra-envelope referential integrity is reported first under `VALIDATION_ERROR`. The missing-user-reference check runs only when the envelope is intra-consistent, and `MISSING_USER_REFS` is raised only on an intra-consistent envelope. A single commit-path response never carries both codes. See [api.md §14.2.4](api.md#1424-unified-data-exchange).

### 15.15 Navigation

- **AC-74** `[vis]`: Navigation between all views (Kanban, Calendar, Projects, Customers, Users, Daten, Aktivität) works without page reload. Shared state is preserved across navigation.
- **AC-75** `[vis]`: Views that require specific permissions are hidden from navigation for unauthorized users. Per-role nav matrix (default role set — see [ui/index.md §8.7.1](ui/index.md#871-views) and [api.md §14.3](api.md#143-authorization-rules)): owner sees Kanban, Kalender, Projekte, Kunden, Benutzer, Daten, Aktivität; office sees everything except Benutzer; worker sees Kanban + Kalender + Aktivität (all scoped — see [AC-145](#1521-role-scoping), [AC-146](#1521-role-scoping), [AC-180](#1523-audit-log)); bookkeeper sees Projekte + Kunden. A role-scoping visual-regression run must walk each role and confirm the nav set matches the matrix exactly.

### 15.16 Management Views

- **AC-76** `[vis]`: The project management view displays a sortable, searchable, filterable table. Active projects are shown by default; archived projects are included when the `Archivierte einblenden` toggle is on (see [AC-152](#1516-management-views)).
- **AC-77** `[vis]`: Creating a project from the management view with number, title, and customer produces a project in the first workflow state. The project appears in the table, the Kanban board, and the Calendar (if dates are set).
- **AC-78** `[vis]`: Editing a project from the management view allows changing title, customer, assigned workers, estimated value, and notes. Status and project number are not editable through this form.
- **AC-79** `[vis]`: Archiving a project from the management view (button label "Archivieren") soft-deletes it. The project disappears from Kanban, Calendar, and the default management list. It still appears in exports with archive state preserved, and in the management list when the "Archivierte einblenden" filter is active. See [ADR-0017](../adr/0017-soft-delete-as-board-archive.md).
- **AC-152** `[vis]`: The project management view has an `Archivierte einblenden` toggle, off by default. When off, only active projects are shown. When on, the request is issued with `includeArchived=true` and archived projects appear in the table alongside active ones.
- **AC-153** `[vis]`: Archived projects shown under the toggle are visually distinguished from active ones — muted row text and an `Archiviert` badge. The distinction is consistent across rows; non-archived rows carry neither.
- **AC-80** `[vis]`: The customer management view displays a searchable, paginated table of all customers with project counts.
- **AC-81** `[vis]`: Creating a customer makes it immediately available in project creation/editing dropdowns without page reload.
- **AC-82** `[vis]`: The user management view is only accessible to users with `user:manage` permission (owner only under the default role set). It displays all users including deactivated ones. `user:read` alone is not sufficient — office holds `user:read` for worker-assignment dropdowns (see [architecture.md §49](architecture.md) and [api.md §14.3](api.md#143-authorization-rules)) but is not admitted to the admin view.
- **AC-83** `[vis]`: Creating a user from the management view produces an account that can log in immediately with the provided credentials.
- **AC-84** `[vis]`: Deactivating a user from the management view prevents that user from logging in and invalidates their active sessions.
- **AC-85** `[vis]`: The critical path "create customer → create project referencing that customer" works without page reload or manual refresh.
- **AC-121** `[crit]`: Any UI control that triggers a mutation requiring a permission the current user lacks is hidden, not rendered and server-rejected. Covers action buttons (create, delete, save, transition, forward) and auto-save inputs (date fields) across the kanban board, management views (projects, customers, users), and the project detail panel. Rationale: rendering an affordance that always 403s is misleading state — the user cannot know in advance which of their actions will succeed.
- **AC-128** `[vis]`: The customer create form shows a dropdown of existing customers whose names case-insensitively contain the current input (substring match). Clicking a match closes the create form and opens that customer's edit form. When no matches are found, no dropdown appears. When the search request fails, no dropdown appears and no error is surfaced — the form continues to function.
- **AC-129** `[vis]`: On submit, if the entered customer name matches an existing customer's name (case-insensitive, whitespace-normalized), a confirmation dialog blocks the create until the user explicitly opts in via "Trotzdem erstellen". Cancelling returns to the form without dispatching a request.
- **AC-130** `[vis]`: On blur of the project number field in the create form, the UI shows a green "available" indicator when no existing project uses the number and a red "taken" indicator when one does. Editing the field after a verdict clears the indicator until the next blur. When multiple checks overlap, the verdict shown reflects the most recent blur — superseded results are discarded. The indicator is UX feedback only — the server is authoritative (see [AC-62](#1512-project-management)).
- **AC-159** `[vis]`: The project management view exposes an `Endgültig löschen` action on archived rows (visible only when the `Archivierte einblenden` toggle is on and the row is `deleted = true`). The action is hidden for users without `project:purge`, per [AC-121](#1516-management-views). A confirmation dialog precedes the request. See [ADR-0017](../adr/0017-soft-delete-as-board-archive.md).

### 15.17 Data Integrity

- **AC-94** `[crit]`: A concurrent state transition on the same project is rejected as a conflict (per the conflict error category in [api.md §14.4.1](api.md#1441-error-categories)). The project remains in the state produced by the first transition.
- **AC-95** `[crit]`: Mutations (transition, date update, PATCH update, soft-delete) on a soft-deleted project are rejected as not found.
- **AC-96** `[crit]`: The database rejects a project row with a `status` value outside the valid workflow states (defense-in-depth CHECK constraint).
- **AC-97** `[crit]`: The database rejects a project row where `plannedEnd < plannedStart` (defense-in-depth CHECK constraint).
- **AC-98** `[crit]`: Deleting a user nullifies the audit references (`createdBy` / `updatedBy`) on any customer records that user created or last modified.
- **AC-99** `[crit]`: Project creation (insert + worker assignment) is atomic. If worker assignment fails (e.g., invalid user ID), the project row is not persisted.
- **AC-127** `[crit]`: A create request carrying a client-supplied `id` that already identifies a row, but whose body differs from the stored row in any participating field, is rejected with the `IDEMPOTENCY_CONFLICT` error code and the German message `"Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet."` The stored row is unchanged. Applies to both customer and project creation.
- **AC-163a** `[crit]`: After `seed(db, { force: true })` completes, the database contains exactly the users enumerated in `SEED_USERS`, 21 customers, 19 projects, and 7 `project_workers` rows. Row counts are the seed's observable contract — drift breaks downstream tests and demo state. See [data-model.md §7](data-model.md#7-seed-data-specification).
- **AC-163b** `[crit]`: After `seed(db, { force: true })` completes, the `users` table carries exactly the users enumerated in `SEED_USERS` — usernames and `active` flags match the constant, and `SEED_DEFAULT_PASSWORD` verifies against every stored `passwordHash`. (`SEED_USERS` and `SEED_DEFAULT_PASSWORD` are test-layer assumption constants pinning seed-produced values.) See [data-model.md §7](data-model.md#7-seed-data-specification).
- **AC-163c** `[crit]`: After `seed(db, { force: true })` completes, every project `number` carries the year prefix matching the calendar year at seed time. See [data-model.md §7](data-model.md#7-seed-data-specification).
- **AC-164** `[crit]`: A malformed users fixture (missing required field, wrong type) causes the seed loader to throw a typed validation error before any row is inserted. No partial state lands in `users`. Rationale: silent partial seed corrupts dev and test state class-wide; fail-fast is the data-integrity posture.

### 15.18 Email Data Intake

- **AC-100** `[crit]`: An unauthenticated email extraction request is rejected with an authentication error.
- **AC-101** `[crit]`: An email extraction request from a user without `customer:write` permission is rejected with an authorization error.
- **AC-102** `[crit]`: Email text that is empty or exceeds 50,000 characters is rejected with a validation error.
- **AC-103** `[crit]`: A successful extraction returns a structured response with a `customer` section (name, phone, email, street, zip, city) and a `project` section (title, description). Fields not present in the input email are `null`.
- **AC-104** `[crit]`: An upstream extraction failure (missing configuration, unreachable service, unparseable response) is mapped to a server error. No internal details leak to the client.
- **AC-105** `[vis]`: The entry point to the email extraction modal is visible only to users with `customer:write` permission.
- **AC-106** `[vis]`: The extraction modal presents a paste textarea and an extract action. The action is disabled while the textarea is empty or an extraction is in flight.
- **AC-107** `[vis]`: After extraction, the modal presents editable customer and project fields for review and supports selecting an existing customer by name to avoid duplicates.

### 15.19 Theming

- **AC-108** `[infra]`: Palette and semantic color tokens are defined in a single source consumed by all components. No component or stylesheet references a palette color outside that source. State colors, applied from the state configuration array, are the single exception. A repository-wide check enforces this boundary.
- **AC-109** `[vis]`: Applying a non-default theme override on the document root replaces the semantic token layer. Components render with the overridden palette without code changes.
- **AC-110** `[vis]`: Dark mode renders via a dark theme override. Every semantic surface has a dark-appropriate value. All text/surface semantic pairs meet WCAG AA contrast — 4.5:1 for normal text and 3:1 for large text — in both light and dark.
- **AC-111** `[vis]`: The theme override is resolved and applied to the document root before the first paint of themed content. Reloading a session with a non-default preference shows no flash of the default theme.
- **AC-112** `[vis]`: When the user's theme preference is `'system'`, operating-system color-scheme changes propagate to the UI without a reload.
- **AC-113** `[infra]`: The brand accent is supplied by the branding configuration with explicit light and dark values. No component or stylesheet hardcodes the accent. A repository-wide check enforces this boundary.
- **AC-114** `[vis]`: Changing the configured accent value updates every accent-using surface — primary actions, links, focus rings, selection highlights, form input indicators — in both modes.

### 15.20 User Theme Preference

- **AC-115** `[crit]`: `themePreference` is stored on each user with a value from `'light' | 'dark' | 'system'`. New users default to `'system'`. The database enforces the allowed set via a CHECK constraint (defense in depth).
- **AC-116** `[crit]`: An authenticated user can update their own theme preference via the self-update API operation. Subsequent responses for the current user return the updated value.
- **AC-117** `[crit]`: A self-update request without a valid session is rejected with an authentication error.
- **AC-118** `[crit]`: A self-update request with an invalid theme value is rejected with a validation error.
- **AC-119** `[vis]`: The user menu exposes a 3-way theme selector ("Hell", "Dunkel", "Systemstandard"). Selecting an option updates the UI immediately and persists server-side; the selection survives a page reload.
- **AC-120** `[vis]`: On session hydration, the server-stored preference replaces any locally cached value. A client on a different device reflects the updated preference after the next session start.

### 15.21 Role Scoping

These criteria pin the per-role read surface described in [index.md §4.2](index.md#42-users) and [api.md §14.3](api.md#143-authorization-rules). They describe behavior, not mechanism — the implementation may realize scoping via a query filter, a repository-layer predicate, or any equivalent approach, as long as the observable contract holds.

- **AC-145** `[crit]`: A worker's `GET /api/projects` returns only projects where the caller is recorded in `project_workers`. A worker assigned to no project receives an empty list. Owner and office receive every non-deleted project (unchanged). Verified by API integration tests using seed users with deterministic assignments.
- **AC-146** `[crit]`: A worker's `GET /api/customers` returns only customers referenced by at least one project where the caller is recorded in `project_workers`. A customer reachable to the worker exclusively through a soft-deleted project is excluded. Owner and office receive every customer (unchanged) — the soft-delete status of a customer's linked projects does not restrict the owner/office customer list, which is the parity clause to AC-145's "every non-deleted project (unchanged)".
- **AC-147** `[crit]`: A worker's `GET /api/projects/:id` succeeds only when the caller is recorded in `project_workers` for that project; otherwise the request is rejected with an authorization error (`NOT_PERMITTED`). The server must not respond with `NOT_FOUND` for a project that exists but the worker is not assigned to — the two outcomes are distinguishable to the caller. This is acceptable under the project's threat model: callers are internal, authenticated users and project IDs are UUIDs that are not enumerable from outside, so resource existence is not a secret at the role boundary (compare with [api.md §14.4.1](api.md#1441-error-categories)'s `NOT_PERMITTED` vs `NOT_FOUND` distinction). Owner and office are unaffected.
- **AC-148** `[crit]`: A worker's `GET /api/customers/:id` succeeds only when the customer is referenced by at least one project where the caller is recorded in `project_workers`; otherwise the request is rejected with an authorization error (`NOT_PERMITTED`). Owner and office are unaffected.
- **AC-149** `[vis]`: A manual URL entry to a path the caller's role is not permitted to access (for example, a worker navigating to `/kunden`) presents an explicit not-permitted error surface in the client: a visible error message indicating the access is denied, no redirect to another view, and the URL in the address bar remains unchanged. This error surface is distinct in presentation from an API 403 returned mid-interaction (see [ui/behavior.md §9.5](ui/behavior.md#95-asynchronous-mutation-behavior)); this criterion covers the route-entry case. Coverage spans every role × every path not permitted for that role under the matrix in [AC-75](#1515-navigation).
- **AC-150** `[vis]`: The export section inside the Daten view ([ui/daten.md §8.11.2](ui/daten.md#8112-export)) is rendered only when the caller holds `data:export`. This is defense-in-depth against the nav-level gate in [AC-142](#1514-data-exchange): even if the Daten route becomes reachable without the permission (e.g. a bug in the nav gate, a manual URL probe, a client build drift), the component itself must not present the download control to a caller who cannot use it. The server remains authoritative ([AC-133](#1514-data-exchange)).

### 15.22 Backup and Recovery

These criteria pin the Layer 2 backup-and-drill cycle ([architecture.md §11.10](architecture.md#1110-full-state-backup-layer-2), [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)). Status fields referenced below are defined in [data-model.md §5.9](data-model.md#59-backup-status-entity).

- **AC-165** `[crit]`: A backup run whose Tier 1 verify-on-create produces a per-table manifest that does not equal the source manifest fails the run. No artifact is uploaded to the off-site object store; `meta_backup_status.lastBackupOk` is `false` and `lastError` identifies the failing table.
- **AC-166** `[crit]`: A backup run whose Tier 1 verify-on-create matches the source manifest uploads the encrypted dump artifact and its encrypted manifest sidecar to the off-site object store; `meta_backup_status.lastBackupOk` is `true` and `lastBackupAt` equals the run timestamp.
- **AC-167** `[crit]`: No backup artifact written to the off-site object store is readable without the operator's private decryption material. Both the dump and the manifest sidecar are encrypted before upload; a run that cannot produce an encrypted artifact fails and uploads nothing. Tool choice lives in [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md).
- **AC-168** `[crit]`: When the operator's private identity is absent from tmpfs, the Tier 2 verify-on-cycle drill is skipped. `meta_backup_status.lastDrillAt` is not advanced and `lastDrillOk` is not coerced from its prior value. A skipped drill is not reported as a failure.
- **AC-169** `[crit]`: Every backup run upserts `meta_backup_status` in the application DB AND writes the status mirror object to the off-site object store with the same `lastBackupAt`, `lastBackupOk`, `lastDrillAt`, `lastDrillOk`, `lastError`, and `updatedAt` values. If the mirror-object write fails after the encrypted artifacts have been uploaded, the artifacts remain in place under the bucket's immutability window, the failure is recorded in `meta_backup_status.lastError`, and the artifacts are subject to the normal retention lifecycle.
- **AC-170** `[vis]`: The backup-freshness badge is rendered on the login screen regardless of authentication state (network reach is VPN-gated per [ADR-0008](../adr/0008-vpn-first-network-access.md), which is the threat-model anchor). On the authenticated admin landing view the badge is visible only to callers with role `owner`. On any other authenticated surface the badge is not rendered.
- **AC-171** `[crit]`: When the status source is unreachable (DB down or the status mirror object not retrievable), the backup-freshness badge renders an explicit "Status unbekannt" state. When `lastDrillAt` is absent (no Tier 2 drill has ever succeeded or failed), the badge renders as drill-stale at the red threshold. The badge is not silently hidden and no stale-but-green state is shown. Rationale: misleading state is a critical defect class per [ADR-0014](../adr/0014-ac-tier-system-critical-vs-design.md).
- **AC-172** `[infra]`: The `backup` compose service is defined in the compose file with the configured interval **[C]** expressed in cron form, and starts with the rest of the stack. Verified by compose-file review — the tier reflects that the observable is the source tree, not a runtime check.
- **AC-173** `[infra]`: The backup bucket has object-lock retention (14 days) AND a lifecycle rule deleting objects 90 days after upload. Verified by infrastructure review against the runbook; direct automated assertion against the provider is not required. Provider and bucket name live in [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) and the runbook.
- **AC-174** `[crit]`: The per-table content checksum is deterministic across runs on identical data. Two backup runs against the same database state produce byte-equal manifest values for every table. Rationale: non-deterministic checksums invalidate Tier 1 and Tier 2 comparison.
- **AC-175** `[infra]`: The operator's private decryption identity is never persisted to disk on the VPS. The drill-key load path writes the identity only into a tmpfs mount; a reboot removes it. Verified by the runbook procedure and by repository-level review of the drill-key load script. Tool choice and script name live in [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md).
- **AC-176** `[crit]`: `GET /api/backup/status` is unauthenticated, returns the `BackupStatus` fields defined in [data-model.md §5.9](data-model.md#59-backup-status-entity), and never leaks fields outside that contract. When the status row is unreachable the response is an explicit `{ available: false }` envelope; a silently-empty body is forbidden (misleading state per [ADR-0014](../adr/0014-ac-tier-system-critical-vs-design.md)).

### 15.23 Audit Log

These criteria pin the single-write-path audit surface ([ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md), [data-model.md §5.10](data-model.md#510-audit-log-entity), [api.md §14.2.8](api.md#1428-audit-log), [ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed), [ui/management.md §8.13](ui/management.md#813-audit-view)).

- **AC-177** `[crit]`: Every mutation on an audited entity (`project`, `customer`, `user`, `project_worker`) produces exactly one `audit_log` row written in the same database transaction as the domain-state change. A domain-state change without its audit row is not possible; an audit row without its state change is not possible. Row carries a non-null `actorId` AND `actorKind = 'user'` when an authenticated caller drove the mutation; a non-null `actorReason` AND `actorKind = 'system'` and null `actorId` when the write originates from an unattended path. Concurrent mutations on the same entity produce serialized audit rows whose order matches the committed state-change order. Each audit row's `payload.before` reflects the state the mutation saw at its read-time within its own transaction (snapshot-isolation semantics).
- **AC-178** `[crit]`: The first-run admin bootstrap ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)) writes an `audit_log` row with `actorKind = 'system'`, null `actorId`, a non-empty `actorReason` (e.g., `"first-run-bootstrap"`), `entityType = 'user'`, and `action = 'create'`. The database's CHECK constraint rejects a system entry whose `actorReason` is null or empty. Rationale: without a non-empty reason, the bootstrap mutation is invisible in the activity feed, leaving the first administrator's creation unaccounted for.
- **AC-179** `[infra]`: A CI-enforced static architecture check fails the build when an audited-table mutation (insert, update, or delete on `project`, `customer`, `user`, or `project_worker`) is authored outside the service-layer `mutate()` helper. The check's audited-table set is derived from `AuditEntityType` in [data-model.md §5.10](data-model.md#510-audit-log-entity) — a new `AuditEntityType` value whose corresponding table is not wired into the check fails CI, so a new audited entity cannot ship without the architecture check observing its mutation surface. `audit_log` itself is not in the audited set: `mutate()` is its legitimate writer, and its integrity is guaranteed by the append-only invariant ([§5.10](data-model.md#510-audit-log-entity)) plus the retention-cleanup allowlist. The check allowlists migrations, the unified restore path ([api.md §14.2.4](api.md#1424-unified-data-exchange)), business-data seed loaders, and the retention cleanup job ([data-model.md §6.10](data-model.md#610-audit-log-retention)). Each allowlist addition is a reviewed line in the check's configuration.
- **AC-180** `[crit]`: A worker's `GET /api/audit` returns entries the worker may see under two composable rules: (a) **reachability** — entries with `entityType = 'project'` for an assigned project, `entityType = 'customer'` for a customer referenced by an assigned project, or `entityType = 'project_worker'` whose payload references an assigned project; AND (b) **self-authorship** — entries with `entityType = 'user'` where `actorId = caller.id` (the worker's own profile activity, e.g. theme preference or password change). Entries with `entityType = 'user'` authored by a different user are never returned to a worker. The reachability predicate parallels the project/customer scope predicate in [ADR-0019](../adr/0019-worker-data-scoping-repository-layer-predicate.md); the self-authorship clause keeps the worker's own audit trail visible without exposing other users' account activity.
- **AC-181** `[crit]`: A worker's `GET /api/audit/:id` on an existing entry outside their scope returns `403 NOT_PERMITTED`; on a non-existent entry returns `404 NOT_FOUND`. The two outcomes are distinguishable at the caller boundary (parity with [AC-147](#1521-role-scoping)).
- **AC-182** `[crit]`: An `audit_log` entry whose `action` is `purge` (any entity type), `delete` on `entityType = 'user'`, or `update` on `entityType = 'user'` where the payload diff touches `roles`, is returned by `GET /api/audit` only to callers for whom the `auditDestructiveScopeForCaller` predicate ([api.md §14.2.8](api.md#1428-audit-log)) returns null (owner under the default role set). For every other role the predicate contributes a `WHERE` fragment at the repository layer that excludes these entries from list and get-by-id responses alike. Permissions remain coarse — `audit:read` admits the caller to the surface; the destructive-action narrowing is orthogonal (parallel to the worker-scope pattern in [ADR-0019](../adr/0019-worker-data-scoping-repository-layer-predicate.md)).
- **AC-183** `[crit]`: A subscriber of the post-commit notification publisher that throws an unhandled exception does not roll back the originating mutation. The domain-state change and the `audit_log` row are committed; the publisher emits a structured operational log line with fields `event = 'audit-publisher-handler-error'`, `audit_entry_id` (the committed row's id), and `error_message`. Rationale: coupling subscriber correctness to domain transactionality would make third-party or future integrations a single point of failure for every mutation.
- **AC-184** `[infra]`: A scheduled cleanup job removes `audit_log` entries older than the configured retention window **[C]** (90 days default, see [architecture.md §12.2](architecture.md#122-company-configurable-settings)). Each run emits exactly one structured operational log line at `info` level with fields `event = 'audit-retention-cleanup'`, `window_days` (integer — the applied retention window), `removed_count` (non-negative integer; `0` on a no-op run), and `ran_at` (ISO 8601 run timestamp). Operators verify retention by querying the operational log for `event = 'audit-retention-cleanup'`; the Aktivität UI does not surface retention events. No `audit_log` row is produced by the cleanup job itself (scope is domain entities only — [data-model.md §5.10](data-model.md#510-audit-log-entity), [§6.10](data-model.md#610-audit-log-retention)).
- **AC-185** `[vis]`: The project detail panel's activity feed renders `audit_log` entries in reverse-chronological order (newest first). Pagination via `"Ältere anzeigen"` fetches and appends older entries; the previously-rendered set does not collapse across a page boundary. The empty state reads `"Keine Aktivität"`.
- **AC-186** `[vis]`: The payload drawer (`Details anzeigen`) is rendered on a feed entry only when the API response for that entry includes a `payload`. For worker callers the drawer is rendered on self-authored rows (where the caller is the actor) and is absent on every other row — the API returns the full `payload` for self-authored activity and strips it elsewhere, per [api.md §14.2.8](api.md#1428-audit-log). For owner and office callers the drawer is rendered on every entry carrying a payload and expands inline without a route change.
- **AC-187** `[crit]`: The owner sees destructive-action entries (`purge`, `delete` on user, role-change updates) in both the per-project activity feed and the global Aktivität view — the `auditDestructiveScopeForCaller` predicate returns null for owner, contributing no filter. Other roles holding `audit:read` (office, worker under the default matrix) do not see these entries in either surface — the same predicate contributes a `WHERE` fragment that excludes them. Verified by listing and get-by-id against the audit endpoint for every role under the default matrix.

---

## 16. Test Specification

### 16.1 Unit Tests

- **UT-4**: State transition — `getNextState('geplant')` returns `'in_arbeit'`.
- **UT-5**: State transition — `getNextState('erledigt')` returns `null`.
- **UT-6**: State transition — `getPreviousState('anfrage')` returns `null`.
- **UT-7**: State transition — `getPreviousState('erledigt')` returns `null`.
- **UT-10**: Password hashing — a hashed password does not match a different plaintext.
- **UT-11**: Password hashing — a hashed password matches the original plaintext.
- **UT-12**: Session expiry — a session past its `expiresAt` is treated as invalid.

### 16.2 API Integration Tests

These tests run against a real (test) database, not mocks.

- **AT-1**: Login with valid credentials returns a session and user profile.
- **AT-2**: Login with invalid credentials returns a generic error.
- **AT-3**: Login with an inactive user account returns a generic error.
- **AT-4**: An authenticated request with a valid session succeeds.
- **AT-5**: A request with an expired session returns an authentication error.
- **AT-6**: A request with no session returns an authentication error.
- **AT-7**: A request with a valid session token for a deactivated user returns an authentication error.
- **AT-8**: List projects returns all seeded projects with correct fields.
- **AT-9**: Transition forward changes `status` and `statusChangedAt`.
- **AT-10**: Transition forward from `erledigt` is rejected.
- **AT-11**: Transition backward from `anfrage` is rejected.
- **AT-12**: Update dates changes `plannedStart`/`plannedEnd` and `updatedAt` but not `statusChangedAt`.
- **AT-13**: Update dates with `plannedEnd` before `plannedStart` is rejected with a validation error.
- **AT-14**: Change own password with correct current password succeeds.
- **AT-15**: Change own password with incorrect current password is rejected.
- **AT-16**: Object storage module can upload a file, retrieve it, and verify the retrieved contents match the original. Tested against the real (deployed) object storage infrastructure.
- **AT-17**: Create project with valid fields returns a project in the first workflow state.
- **AT-18**: Create project with a duplicate number is rejected with status 409 and error code `CONFLICT`. The message names the conflicting number.
- **AT-19**: Create project with a non-existent `customerId` is rejected with a validation error.
- **AT-20**: Update project changes the specified fields and preserves others. `updatedAt` and `updatedBy` are set server-side.
- **AT-21**: Update project does not accept `status` or `number` changes.
- **AT-22**: Delete project sets `deleted = true`. The project is excluded from list results.
- **AT-23**: Create customer with a name returns a customer with a generated ID.
- **AT-24**: Update customer with PATCH semantics — omitted fields unchanged, `null` clears optional fields.
- **AT-25**: List customers with `search` parameter filters by name substring.
- **AT-26**: `GET /api/customers/:id` returns `projectCount` (active projects) and `archivedProjectCount` (soft-deleted projects) alongside the customer row. Pins [AC-57](#1511-customer-management) and the data prerequisite for [AC-154](#1511-customer-management).
- **AT-27**: List users returns all users (including deactivated) without `passwordHash`.
- **AT-28**: Create user with valid fields returns a user that can log in.
- **AT-29**: Create user with a duplicate username is rejected with a validation error.
- **AT-30**: Update user changes display name and roles. Username is immutable.
- **AT-31**: Deactivate user sets `active = false` and invalidates all sessions for that user.
- **AT-32**: Reactivate user sets `active = true`. The user can log in again.
- **AT-33**: Reset password changes the user's password and invalidates all sessions for the target user.
- **AT-34**: Self-deactivation is rejected with an error.
- **AT-38**: User management operations require `user:manage` permission — office/worker/bookkeeper roles are rejected.
- **AT-39**: List projects with status filter returns only matching projects.
- **AT-40**: List projects with search parameter filters across number, title, and customer name.
- **AT-41**: List projects with `hasNoDates` filter returns only projects without planned dates.
- **AT-42**: Transition on a soft-deleted project is rejected as not found.
- **AT-43**: Date update on a soft-deleted project is rejected as not found.
- **AT-44**: PATCH update on a soft-deleted project is rejected as not found.
- **AT-45**: Direct INSERT of a project with an invalid status is rejected by the database CHECK constraint.
- **AT-46**: Direct INSERT of a project with `plannedEnd < plannedStart` is rejected by the database CHECK constraint.
- **AT-47**: Deleting a user nullifies `createdBy`/`updatedBy` on customer records that user created or last modified.
- **AT-48**: Project creation with an invalid worker ID rolls back the entire operation — no orphan project row.
- **AT-49**: Two concurrent forward transitions on the same project — one succeeds, the other is rejected as a conflict (`CONFLICT` error code). The project advances exactly one step.
- **AT-50**: Unauthenticated email extraction request is rejected with an authentication error.
- **AT-51**: Email extraction request from a user without `customer:write` permission is rejected with an authorization error.
- **AT-52**: Email extraction with empty text is rejected as a validation error.
- **AT-53**: Email extraction with text exceeding 50,000 characters is rejected as a validation error.
- **AT-54**: Email extraction with valid input (mocked upstream) returns structured customer and project fields.
- **AT-55**: Upstream extraction failure returns a server error without leaking internal details.
- **AT-56**: A newly created user has `themePreference = 'system'` when the field is not supplied.
- **AT-57**: Direct INSERT of a user with an invalid `themePreference` value is rejected by the database CHECK constraint.
- **AT-58**: Self-update with a valid `themePreference` updates the user row. A subsequent `GET /api/auth/me` returns the new value.
- **AT-59**: Self-update without a valid session is rejected with an authentication error.
- **AT-60**: Self-update with an invalid `themePreference` value is rejected with a validation error.
- **AT-61**: Create customer with a client-supplied id replayed under the same id and body returns the same row and does not duplicate — a subsequent list search by name returns exactly one matching record.
- **AT-62**: Create project with a client-supplied id replayed under the same id and body (including order-flipped `assignedWorkerIds` and high-precision `estimatedValue`) returns the same row and does not duplicate — a subsequent list by number returns exactly one matching record.
- **AT-63**: Create customer with a client-supplied id whose body differs from a prior create under the same id is rejected with status 409 and error code `IDEMPOTENCY_CONFLICT`. The stored row is unchanged.
- **AT-64**: Create project with a client-supplied id whose body differs from a prior create under the same id is rejected with status 409 and error code `IDEMPOTENCY_CONFLICT`. The stored row is unchanged.
- **AT-65**: In a create form whose submit opens a confirmation dialog before dispatch, a second submit triggered while the confirm is open does not cause a second create request when the confirm is resolved — exactly one create call fires.
- **AT-66**: Two concurrent creates for a customer with the same client-supplied id and identical body result in status codes `{201, 201}` and a single persisted row whose id matches the supplied value.
- **AT-67**: Two concurrent creates for a project with the same client-supplied id and differing bodies result in status codes `{201, 409}`; the 409 response carries `IDEMPOTENCY_CONFLICT`, and the committed row's fields match the 201 winner.
- **AT-68**: The periodic session reaper deletes expired session rows on its configured interval; a graceful `stop()` awaits any in-flight sweep before resolving.
- **AT-69**: `GET /api/export` rejects unauthenticated requests (401) and authenticated requests from roles without `data:export` (403 `NOT_PERMITTED`); owner and office return 200.
- **AT-70**: `POST /api/import` rejects unauthenticated requests (401) and authenticated requests from roles without `data:restore` — including office (403 `NOT_PERMITTED`); owner with a valid envelope into an empty DB returns 200.
- **AT-71**: The export envelope contains `schema_version`, `exported_at`, `customers`, `projects`, `project_workers` with row-level fidelity. Projects soft-deleted before export are present with `deleted = true`. Users, sessions, and password hashes are absent from the serialized body.
- **AT-72**: An import envelope whose `schema_version` differs from the current value (both `+1` and `-1`) is rejected with a specific error code and the database remains unchanged.
- **AT-73**: An import into an empty database with a valid envelope returns 200, preserves IDs exactly, and is transactional — an envelope whose last row references a non-existent customer aborts with zero writes persisted.
- **AT-74**: An import into a non-empty database without the `override` flag is rejected with a specific error code; the original data is unchanged.
- **AT-75**: An import into a non-empty database with `override=true` wipes existing business data and restores atomically. An invalid row inside an override import rolls back to the original seeded state.
- **AT-76**: A dry-run import (`dry_run=true`) validates the envelope, returns a preview shape containing would-write counts and validation errors, and writes nothing — both for valid and invalid envelopes.
- **AT-77**: A full roundtrip — seed → export → wipe → import (override) → export — produces content-equivalent envelopes (`schema_version`, `customers`, `projects`, `project_workers` deep-equal; `exported_at` excluded).
- **AT-78**: `GET /api/projects` accepts an `includeArchived` query parameter (boolean, default false). When false or omitted, archived rows are excluded; when true, archived rows are returned with `deleted = true`. The parameter AND-composes with the other list filters. Pins [AC-151](#1512-project-management).
- **AT-79**: `DELETE /api/projects/:id/purge` as owner hard-deletes an archived project. Subsequent GET returns 404; list with `includeArchived=true` omits the row; any `project_workers` rows are gone. Pins [AC-155](#1512-project-management).
- **AT-80**: `DELETE /api/projects/:id/purge` against a non-archived project returns 409 with the German message and the project row is unchanged. Pins [AC-156](#1512-project-management).
- **AT-81**: `DELETE /api/projects/:id/purge` by a caller without `project:purge` (owner → yes; office/worker/bookkeeper → 403). Against a non-existent id returns 404. Pins [AC-157](#1512-project-management) and [AC-158](#1512-project-management).
- **AT-82**: `POST /api/import?override=true` into a non-empty database with a missing or non-matching `confirmation_phrase` returns 422 `RESTORE_CONFIRMATION_MISMATCH`; the original data is unchanged. With a phrase matching the configured value (including one whose body has leading/trailing whitespace) the request returns 200 and the atomic wipe+restore completes. Comparison is case-sensitive — a case-different phrase is rejected. Pins [AC-160](#1514-data-exchange).
- **AT-83**: `POST /api/import?override=true` without `confirmation_phrase` is accepted on the exempt paths — `dry_run=true` returns 200 with the preview; an override into an empty database returns 200 and restores successfully. Pins [AC-160](#1514-data-exchange).
- **AT-84**: `POST /api/import` (commit path, no `dry_run`) with an intra-consistent envelope whose `project_workers[].userId`, `customers.createdBy/updatedBy`, or `projects.createdBy/updatedBy` references a user id absent from the target `users` table returns 422 `MISSING_USER_REFS`; `details.missingUserIds` is deduplicated and `details.references` carries one `{ path, userId }` entry per offending site (including duplicate user-ids mapped to distinct paths). Null / missing audit-field values do not trigger the code. The database is unchanged. Pins [AC-162a](#1514-data-exchange).
- **AT-85**: `POST /api/import?dry_run=true` with an envelope that is both intra-inconsistent (e.g., a `projects[].customerId` pointing to a missing envelope customer) and carries a missing-user reference returns 200 with a preview that surfaces both classes of issue; no writes are persisted. Pins [AC-162b](#1514-data-exchange).
- **AT-86**: `POST /api/import` (commit path) with an envelope that is both intra-inconsistent and carries a missing-user reference returns a single error response under `VALIDATION_ERROR` for the intra-envelope problem; `MISSING_USER_REFS` is not returned until the envelope is intra-consistent. A follow-up commit whose envelope is intra-consistent but still carries a missing-user reference returns `MISSING_USER_REFS`. The two codes are never returned in the same response. Pins [AC-162c](#1514-data-exchange).
- **AT-87**: `seed(db, { force: true })` on an empty database populates `users`, `customers`, `projects`, and `project_workers` with row counts matching the seed contract (users per `SEED_USERS`, 21 customers, 19 projects, 7 `project_workers`); every username in `SEED_USERS` is present with the expected `active` flag, `SEED_DEFAULT_PASSWORD` verifies against each user's `passwordHash`, and every project `number` carries a year prefix matching the calendar year at seed time. Pins [AC-163a](#1517-data-integrity), [AC-163b](#1517-data-integrity), [AC-163c](#1517-data-integrity).
- **AT-88**: `seed(db, { force: true })` with a malformed users fixture (missing required field or wrong type) throws a typed validation error and leaves `users` empty — no partial insert is observable. Pins [AC-164](#1517-data-integrity).
- **AT-89**: A domain-entity mutation driven by the service-layer `mutate()` helper commits an `audit_log` row atomically with the state change. When the mutation fails after the state write but before the audit write (or vice versa) the transaction aborts and neither artifact is persisted. Pins [AC-177](#1523-audit-log).
- **AT-90**: The first-run admin bootstrap path produces an `audit_log` row with `actorKind = 'system'`, null `actorId`, a non-empty `actorReason`, `entityType = 'user'`, and `action = 'create'`. A direct INSERT of an `audit_log` row with `actorKind = 'system'` and null/empty `actorReason` is rejected by the database's CHECK constraint. Pins [AC-178](#1523-audit-log).
- **AT-91**: A worker's `GET /api/audit` returns the expected scoped set against a seeded fixture with at least one assigned project, one unassigned project, one referenced customer, and an unreachable customer — the response omits entries from unassigned projects, unreachable customers, and every `entityType = 'user'` row. Owner and office receive every entry. Pins [AC-180](#1523-audit-log).
- **AT-92**: A worker's `GET /api/audit/:id` returns `200` for an in-scope entry, `403 NOT_PERMITTED` for an existing entry outside scope, and `404 NOT_FOUND` for a non-existent id. The three outcomes are distinguishable at the caller boundary. Pins [AC-181](#1523-audit-log).
- **AT-93**: `GET /api/audit` admits entries whose `action` is `purge` (any entity type), `delete` on `entityType = 'user'`, or `update` on `entityType = 'user'` touching `roles` only to callers for whom `auditDestructiveScopeForCaller` returns null (owner under the default role set). Every other role with `audit:read` receives no such entries in list responses; get-by-id on such an entry returns `403 NOT_PERMITTED`. Pins [AC-182](#1523-audit-log), [AC-187](#1523-audit-log).
- **AT-94**: A notification subscriber registered with the post-commit publisher that throws during dispatch does not roll back the originating mutation — the domain-state change and the `audit_log` row are committed; the failure surfaces as a structured operational log line carrying `event = 'audit-publisher-handler-error'`, the `audit_entry_id`, and the `error_message`. Pins [AC-183](#1523-audit-log).
- **AT-95**: The audit-retention cleanup job removes `audit_log` entries older than the configured window and emits a structured operational log line carrying the applied window and the removed row count. No `audit_log` row is produced by the cleanup. Pins [AC-184](#1523-audit-log).

### 16.3 E2E Tests

The end-to-end path is covered by focused, isolated test files rather than a single monolithic scenario. This improves test isolation, failure diagnostics, and net-zero teardown. The steps below define the required behavioral coverage; the implementation may split them across multiple test files and specs.

**Smoke (login/logout cycle)**:

1. App loads — login screen is displayed.
2. User enters credentials and logs in — Kanban view is displayed with 9 columns.
3. Header shows user's display name.
4. User clicks "Abmelden" — login screen appears.

**Kanban flows (state transitions, dates, calendar, persistence)**: 4. Summary area shows `"3× Rechnung fällig"`. 5. User clicks a summary indicator — view filters to matching projects. 6. User clicks "Filter aufheben" — full view restored. 7. User clicks a card in `Geplant` — detail panel opens. 8. User clicks "Nächster Schritt" — confirmation dialog appears. 9. User confirms — card moves to `In Arbeit`. 10. User clicks "Vorheriger Schritt" on the same card — card moves back to `Geplant`. 11. User changes planned end date via date picker in detail panel. 12. User switches to calendar view — the project bar reflects the new date. 13. User clicks "X Projekte ohne Termin" — switches to filtered Kanban. 14. Summary area reflects current state counts throughout. 15. User refreshes the page — changes persist; user remains logged in. 17. Pressing browser back button after logout does not show project data.

**Management flows (project, customer, user CRUD)**:

18. User navigates to the Customer Management view and creates a new customer with name and address.
19. User navigates to the Project Management view and creates a new project, selecting the just-created customer.
20. The new project appears in the Kanban board under the first workflow state.
21. User navigates to the Project Management view, searches for the new project, and edits its notes.
22. An owner navigates to the User Management view and creates a new user with the worker role.
23. The owner deactivates the new user. A separate browser context confirms the deactivated user cannot log in.
24. The owner reactivates the user. The user can log in again.

**Data exchange flows**:

25. User with `data:export` clicks the export action in the Daten view. The downloaded file is a unified JSON envelope covering every customer, project, and project-worker assignment, including archived rows.
26. User with `data:restore` uploads an exported envelope into an empty database via the restore form. The dry-run preview renders, the user commits, and the restored rows match the source by ID.
27. User with `data:restore` attempts the same restore into a non-empty database. The UI surfaces a destructive-action warning with a confirmation-phrase input and keeps the commit disabled. After the user types the configured phrase **[C]**, the commit enables; on confirm, the server re-validates the phrase and the request succeeds as an atomic wipe+restore.

---

## 17. Risks and Mitigations

| Risk                                               | Impact                             | Mitigation                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9 Kanban columns too tight on screen               | Usability                          | Horizontal scroll; responsive collapse tiers ([ui/behavior.md §10](ui/behavior.md#10-responsive-behavior)).                                                   |
| Over-styling action columns                        | Defeats Kanban principle           | Trust board structure; resist decorative urgency.                                                                                                             |
| API latency makes transitions feel sluggish        | Interaction feels unresponsive     | Optimistic UI updates + sub-300ms API target ([architecture.md §13.2](architecture.md#132-performance)).                                                      |
| Session management edge cases                      | User loses work or sees stale data | Sessions are checked on every API call. Expiry redirects to login cleanly. All mutations are immediate (no local drafts to lose).                             |
| Seed data dates become stale over time             | Demo loses impact                  | Dates are relative to deployment date ([data-model.md §7.5](data-model.md#75-date-range)). A re-seed operation refreshes them.                                |
| Soft-deleted projects consume storage indefinitely | Database growth                    | Archived projects are purged when their customer is deleted ([ADR-0017](../adr/0017-soft-delete-as-board-archive.md)). Customer deletion is the cleanup path. |
