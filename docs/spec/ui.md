# UI Specification

## 8. UI Specification

### 8.1 Layout

The application has two top-level layout states depending on authentication.

#### 8.1.1 Unauthenticated State

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                     App Name / Logo                      │
│                                                          │
│                    ┌──────────────┐                      │
│                    │  Benutzername│                      │
│                    ├──────────────┤                      │
│                    │  Passwort    │                      │
│                    ├──────────────┤                      │
│                    │  [Anmelden]  │                      │
│                    └──────────────┘                      │
│                                                          │
│                    (error area)                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

The login screen is minimal: app name/logo, username field, password field, a submit button labeled "Anmelden", and an error area for failed attempts. The server returns a generic error message on failed login — no distinction between "user not found" and "wrong password" to avoid information leakage. The client displays the server-provided message. The generic behavior is enforced server-side, not client-side.

The login screen is the **only** view available to unauthenticated users. No project data is accessible without authentication.

#### 8.1.2 Authenticated State

```
┌──────────────────────────────────────────────────────────┐
│ [Insecure banner — only in insecure-mode evaluation]     │
├──────────────────────────────────────────────────────────┤
│  Header: App Name  |  Navigation (§8.7)  |  Summary      │
│                                    [Maria Schmidt ▾]     │
├──────────────────────────────────────────────────────────┤
│ [Mutation error banner — only when a mutation failed]    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                     Active View                          │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Footer: configurable text [C]                           │
└──────────────────────────────────────────────────────────┘
```

- **Insecure banner**: non-dismissible, visually prominent warning shown when the page loaded over plain HTTP on a non-localhost host. Covers both login and authenticated layout. See [AC-45](verification.md#156-deployment) and [ADR-0013](../adr/0013-http-only-evaluation-mode.md).
- **Header**: app name **[C]**, navigation ([§8.7](#87-navigation)), summary indicators.
- **User indicator**: displays the authenticated user's `displayName`. Clicking reveals a dropdown — see [§8.7.2](#872-user-menu).
- **Mutation error banner**: appears when the most recent mutation failed. German message from the API error category (see [§9.5](#95-asynchronous-mutation-behavior)), dismiss button. Cleared on next successful mutation or by dismissal.
- **Default view**: Kanban.
- **Footer**: text driven by branding config **[C]**.

---

### 8.2 Kanban View

#### 8.2.1 Columns

The board has **9 columns**, one per workflow state (see [index.md — Workflow States](index.md#3-workflow-states)). Each column header shows the German label and the card count.

Action columns are visually distinct from buffer columns (e.g., warm-tinted background for action, neutral for buffer).

#### 8.2.2 Project Card

```
┌─────────────────────────────┐
│ [●] 2026-042                │
│ Fassadenanstrich Müller     │
│ Familie Müller              │
│ 14.04. – 18.04.2026         │
│                        [→]  │
└─────────────────────────────┘
```

- **[●]** Color dot matching the state color (see 8.6).
- **Project number** and **title**.
- **Customer name**.
- **Date range** if available; `"Kein Termin"` otherwise.
- **[→] button** advances to the next workflow state with a German confirmation dialog showing current and target state. Hidden for `Erledigt` cards.

Cards within a column are sorted by `statusChangedAt` ascending (longest-waiting on top).

#### 8.2.3 Entry Date and Aging

Every card shows its `statusChangedAt` as a date label. The `"seit X Tagen"` aging text is a separate indicator that appears below for aged buffer cards — both the date and the aging text are shown.

**Action states**: after a configurable threshold (`agingBoldDays`), the entry date turns **bold** — a subtle but clear flag that this item has been waiting too long. Default thresholds **[C]**:

- Anfrage: 3 days
- Beauftragt: 5 days
- Rechnung fällig: 3 days

**Buffer states**: after a configurable threshold, the entry date turns bold AND the card additionally shows `"seit X Tagen"` as a text indicator. The state config carries **two** fields for buffer states — `agingBoldDays` controls when the entry date switches to bold, and `agingThresholdDays` controls when the `"seit X Tagen"` text appears. The fields are kept separate so the two effects can be staggered (e.g., bold at 14 days, "seit X Tagen" at 18) via configuration; in the default config both values match so the effects transition together. See [data-model.md §5.2](data-model.md#52-state-metadata) for the field mapping. Default thresholds **[C]**:

- Angebot: 14 days
- Geplant: 21 days
- Abnahme: 7 days
- Abgerechnet: 30 days

#### 8.2.4 Interactivity

- **Click on a card** → opens the Project Detail Panel (8.4).
- **[→] button** → state transition with confirmation dialog.
- **Drag between adjacent columns** → optional. If implemented, only adjacent-column drops are accepted (no skipping states).

---

### 8.3 Calendar View

#### 8.3.1 Display

- **Default**: month view of the current month. Navigation to previous/next months.
- **Week view toggle**: available via Monat/Woche buttons in the calendar navigation bar. Month view is the default; week view shows a single week with date-range label.
- Projects with `plannedStart` and `plannedEnd` render as **horizontal bars** spanning those dates.
- Projects with only `plannedStart` (no `plannedEnd`) render as a **single-day block** on the start date.
- Bar color encodes the workflow state (see 8.6).
- Projects without planned dates do **not** appear. A counter below the calendar reads: `"X Projekte ohne Termin"` — clicking it switches to Kanban view AND applies a "no dates" filter so only the undated projects are visible. A `"Filter aufheben"` button clears the filter, and switching views also clears it.

#### 8.3.2 Interactivity

- **Click on a project bar** → opens the Project Detail Panel (8.4).
- **Date editing** is done via the Project Detail Panel (8.4).

---

### 8.4 Project Detail Panel

A detail view that preserves the context of the underlying view (the user should not lose sight of the board or calendar).

Contents:

- Project number, title
- Current status with colored badge + German label
- **Forward transition button** (same as [→]). Hidden for `Erledigt`.
- **Backward transition button**, styled less prominently. Hidden for `Anfrage` (no previous state) and `Erledigt` (terminal).
- Customer: name, phone (clickable), email (clickable)
- Address (clickable map link if available)
- **Dates: planned start/end** — editable via date picker inputs. Changes update `plannedStart`/`plannedEnd` and are reflected in both views immediately. The UI prevents invalid combinations: clearing `plannedStart` while `plannedEnd` is set also clears `plannedEnd` (see [data-model.md §6.8](data-model.md#68-date-validation)).
- Assigned workers (list of display names). Editing is available in the Project Management View ([§8.8.3](#883-edit-project)).
- Estimated value, formatted as `8.500,00 €` (German locale)
- Notes (read-only in the Kanban/Calendar context; editable in the Project Management View, [§8.8.3](#883-edit-project))
- Timestamps: created, last updated, status changed

---

### 8.5 Summary Area

Displayed in the header. Shows aggregate counts computed from current project data:

- Count of projects in each action state: e.g., `"3× Rechnung fällig"`, `"2× Anfrage"`
- Count of projects in buffer states exceeding aging thresholds: e.g., `"1 Angebot seit >14 Tagen"`

Indicators remain visible across all views as reminders of open items requiring attention. Clicking an indicator from any view navigates to the Kanban view and applies the filter; clicking the same active indicator clears it without navigating. For action-state indicators, this filters to all projects in that state. For aged buffer indicators, this filters to only the projects exceeding the threshold — not all projects in that buffer state. The filter state must distinguish between "all projects in state X" (action-state filter) and "only aged projects in state X" (buffer-aging filter). Non-matching cards are hidden (not dimmed). A `"Filter aufheben"` (clear filter) button appears in the summary area while a filter is active. Switching views clears the filter.

Summary values update immediately after any state change.

---

### 8.6 Color Coding

Each state has an assigned color. Action states use warm tones, buffer states use cool tones.

| State           | Type   | Suggested Color | Hex       |
| --------------- | ------ | --------------- | --------- |
| Anfrage         | Action | Orange          | `#F97316` |
| Angebot         | Buffer | Light blue      | `#93C5FD` |
| Beauftragt      | Action | Amber           | `#F59E0B` |
| Geplant         | Buffer | Blue            | `#3B82F6` |
| In Arbeit       | Active | Green           | `#22C55E` |
| Abnahme         | Buffer | Teal            | `#14B8A6` |
| Rechnung fällig | Action | Red             | `#EF4444` |
| Abgerechnet     | Buffer | Indigo          | `#6366F1` |
| Erledigt        | Done   | Gray            | `#9CA3AF` |

Colors are configurable via the state configuration (see [Data Model — State Metadata](data-model.md#52-state-metadata)). The warm/cool grouping is the design principle; exact values may be adjusted during implementation.

---

### 8.7 Navigation

The authenticated layout provides navigation between all available views. The navigation mechanism (sidebar, top tabs, or other) is an implementation decision.

#### 8.7.1 Views

| View          | Label      | Access                                                     | Default                        |
| ------------- | ---------- | ---------------------------------------------------------- | ------------------------------ |
| Kanban        | "Kanban"   | All authenticated users                                    | Yes (landing view after login) |
| Calendar      | "Kalender" | All authenticated users                                    | No                             |
| Projects      | "Projekte" | All authenticated users                                    | No                             |
| Customers     | "Kunden"   | All authenticated users                                    | No                             |
| Users         | "Benutzer" | `user:read` permission required                            | No                             |
| Import/Export | "Daten"    | Visible to all; operations gated by per-action permissions | No                             |

Navigation between views preserves shared state (cached project list, customer list, authenticated user). Switching views clears any active filter.

Views that the user lacks permission to access are hidden from navigation. Server-side authorization remains authoritative — hiding is a UX convenience.

#### 8.7.2 User Menu

The user menu (accessible from the header area) provides:

- Display of the authenticated user's `displayName`
- "Darstellung" — a 3-way theme selector with options "Hell" (light), "Dunkel" (dark), "Systemstandard" (system). Selecting an option applies immediately and persists server-side (see [§9.6](#96-theme-handling)).
- "Passwort ändern" — opens a password change form (current password, new password, confirmation)
- "Abmelden" — logs out and returns to the login screen

---

### 8.8 Project Management View

A tabular list of all projects with search, filtering, and CRUD operations.

#### 8.8.1 List

- Columns: project number, title, customer name, status (colored badge), planned dates, estimated value, assigned workers.
- Sortable by any column. Default sort: project number descending.
- Search: free-text filter across project number, title, and customer name.
- Filters: by status (multi-select), by customer, by date range (planned start), by "has no dates" flag. Filters use AND logic. A "Filter aufheben" control clears all filters.
- Pagination when the list exceeds a configurable page size **[C]**.
- Soft-deleted projects are excluded.

#### 8.8.2 Create Project

Accessible via a primary action button. Requires `project:create` permission (button hidden otherwise).

Fields:

- **Project number** — auto-suggested from the configured format **[C]**, editable by the user, immutable after creation.
- **Title** — required.
- **Customer** — required. Selection from existing customers, with an option to create a new customer inline (see [§8.9.4](#894-inline-customer-creation)).
- **Status** — defaults to the first workflow state. Optionally selectable if configuration allows **[C]**.
- **Planned start / Planned end** — optional. Same validation as the detail panel (end requires start).
- **Assigned workers** — optional multi-select from active users with the `worker` role.
- **Estimated value** — optional numeric input.
- **Notes** — optional free text.

On success, the new project appears in the list and in Kanban/Calendar views.

#### 8.8.3 Edit Project

Clicking a project row opens the project for editing. The editing surface reuses the Project Detail Panel ([§8.4](#84-project-detail-panel)) with expanded editability:

- **Planned start / Planned end** — editable via date inputs. Same validation as the detail panel (end requires start, end disabled when start is empty).
- **Notes** are editable.
- **Assigned workers** are editable via multi-select.
- **Estimated value** is editable.
- **Customer** can be changed.

All editable fields use PATCH semantics via the Update project API operation. Status changes use their dedicated transition operations. Date changes use the dedicated update-dates operation (see [api.md §14.2.2](api.md#1422-projects)).

Requires `project:update` permission for mutations. Users without this permission see all fields as read-only.

#### 8.8.4 Delete Project

Available per project row or in the edit view. Confirmation dialog: `"Projekt {number} wirklich löschen?"` with OK / Abbrechen. Soft-deletes via the API.

Requires `project:delete` permission.

---

### 8.9 Customer Management View

A tabular list of all customers with search and CRUD operations.

#### 8.9.1 List

- Columns: name, phone, email, city, project count, last updated.
- Search: name substring filter (case-insensitive), matching the API's `search` parameter.
- Pagination when the list exceeds a configurable page size **[C]**.
- Clicking a customer's project count navigates to the Project Management View filtered to that customer.

#### 8.9.2 Create Customer

Accessible via a primary action button. Requires `customer:write` permission.

Fields:

- **Name** — required.
- **Phone** — optional.
- **Email** — optional.
- **Address** — optional nested group: street, zip, city.
- **Notes** — optional free text.

If a customer with the same name already exists, the UI offers to navigate to the existing record for editing instead of creating a duplicate.

On success, the new customer appears in the list and is immediately available in project creation/editing dropdowns.

#### 8.9.3 Edit Customer

Clicking a customer row opens the customer for editing. PATCH semantics: omitted fields unchanged, explicit `null` clears optional fields.

Requires `customer:write` permission for mutations. Users without this permission see all fields as read-only.

#### 8.9.4 Inline Customer Creation

When creating or editing a project ([§8.8.2](#882-create-project), [§8.8.3](#883-edit-project)), the customer selector includes an option to create a new customer inline. On successful creation, the new customer is automatically selected for the project.

---

### 8.10 User Management View

An administrative view for managing user accounts. Only accessible to users with `user:read` permission. Hidden from navigation for users without this permission.

#### 8.10.1 List

- Columns: display name, username, roles (as badges), email, active status indicator, last login.
- Shows all users including deactivated ones. Deactivated users are visually distinct.

#### 8.10.2 Create User

Accessible via a primary action button. Requires `user:manage` permission (button hidden otherwise).

Fields:

- **Username** — required, unique, immutable after creation.
- **Display name** — required.
- **Password** — required. Must meet the configured password policy **[C]**. Includes a confirmation field; submission is blocked until both entries match.
- **Roles** — required. Multi-select from the configured role set **[C]**.
- **Email** — optional.

#### 8.10.3 Edit User

Clicking a user row opens the user for editing. Editable fields: display name, roles, email. Username is read-only.

Password is not part of the edit form — password reset uses a dedicated operation ([§8.10.5](#8105-reset-password)).

Requires `user:manage` permission for mutations.

#### 8.10.4 Deactivate / Reactivate

Available as a row action or within the edit view. Requires `user:manage` permission.

- **Deactivate**: confirmation dialog. Self-deactivation is rejected by the API; the UI should prevent it.
- **Reactivate**: confirmation dialog.

#### 8.10.5 Reset Password

Available as a row action or within the edit view. Opens a form with new password plus confirmation. Must meet the configured password policy.

Administrative action — does not require the target user's current password. Invalidates all of the target user's sessions.

Requires `user:manage` permission.

#### 8.10.6 Delete User

Available within the user detail view. Confirmation dialog. Self-deletion is prevented (button hidden for the authenticated user's own record; API rejects if attempted). Hard-deletes the user and cascades related data (sessions, worker assignments).

Requires `user:delete` permission (owner only).

---

### 8.11 Import/Export View

A dedicated view for bulk data operations.

#### 8.11.1 Import

Supports two entity types: projects and customers. The active entity type is selectable.

**Workflow:**

1. **Upload** — user selects a JSON file. The client parses and displays a preview table.
2. **Validation preview** — the preview highlights rows with detectable client-side issues (missing required fields, type mismatches). For customer imports, rows matching existing customers by name are flagged as overwrites. Client-side validation is a convenience; server-side is authoritative.
3. **Submit** — user confirms import. If the preview flagged customer overwrites, the UI requires explicit confirmation before committing. The client sends the parsed array to the bulk import API.
4. **Result** — summary of imported count and failed rows with index and German error message. The user can correct and re-upload failed rows.

Permission requirements: project import requires `project:create`, customer import requires `customer:write`. Users without permission see a clear indication that they cannot import.

#### 8.11.2 Export

Supports two entity types: projects and customers.

**Workflow:**

1. **Configure** — user selects entity type and optional filters (project: status, customer, date range; customer: has-projects / no-projects).
2. **Export** — triggers file download. JSON format. Filename includes entity type and date.

Permission requirements: project export requires `project:read`, customer export requires `customer:read`.

Exports never include soft-deleted projects or password hashes.

---

### 8.12 Email Data Intake

A modal interface for extracting customer and project data from raw email text via an LLM. See [ADR-0015](../adr/0015-copy-paste-textarea-email-data-intake.md) for the copy/paste rationale and [ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md) for the server-side proxy design.

Entry point: a button in the header, visible only to users with `customer:write` permission.

**Workflow:**

1. **Paste** — the user pastes raw email text into a textarea. The extract action is disabled while the textarea is empty or an extraction is in flight.
2. **Extract** — submitting triggers a call to the extraction API (see [api.md §14.2.6](api.md#1426-data-extraction)). While the request is in flight, the UI shows a loading indicator and the extract action is disabled.
3. **Review** — on success, the modal presents editable form fields populated from the extraction result: customer name, phone, email, street, zip, city, and project title. Fields that the LLM could not infer are shown empty. The user corrects or completes them before saving.
4. **Match existing customer** — the customer section includes a name search that queries existing customers. The user may select an existing record to avoid creating a duplicate; in that case, only the project is created on save.
5. **Save** — the client creates the customer first (if no existing match was selected), then creates the project referencing that customer's ID. On customer failure, no project is created. Project failure after a new customer was just created does not roll back the customer.
6. **Error feedback** — extraction failure (configuration missing, upstream error, unparseable response) shows a German error message from the API error category. The user may retry or abandon the flow.

Permission: `customer:write`. Users without this permission cannot see the entry point and cannot invoke the operation (server-side authorization is authoritative).

---

## 9. Behavioral Rules

### 9.1 State Transitions

- **Forward**: to the next state in the sequence. Allowed from any state except `erledigt`.
- **Backward**: to the immediately preceding state. Allowed from any state except `anfrage` (no previous) and `erledigt` (terminal).
- **No skipping**: direct jumps across multiple states are not allowed.
- **Terminal**: `erledigt` is a terminal state — no forward or backward transitions. Both transition buttons are hidden. Terminality is a domain rule, not just a UI rule.
- Every transition requires a German confirmation dialog showing current and target state.

Enforcement happens both server-side (API rejects invalid transitions) and client-side (buttons hidden). Server-side is authoritative.

### 9.2 Inaction Visibility

Visibility is provided by three mechanisms:

**Board structure** (primary): action columns with accumulated cards are immediately visible. The column IS the signal.

**Entry date and aging indicators**: per [§8.2.3](#823-entry-date-and-aging), cards show their entry date with bold thresholds and, for buffer states, a `"seit X Tagen"` text indicator.

### 9.3 Date Handling

- Display dates use the configured locale format **[C]**. Default: German (`DD.MM.YYYY`).
- Week starts on **Monday** (ISO 8601).
- No time zones — all dates are local calendar dates.

### 9.4 Authentication Behavior

- On app load, the client checks for an existing valid session. If valid → load authenticated view. If expired or absent → login screen.
- After successful login, the client fetches the full project list and renders the default view (Kanban).
- Logout clears the local session and returns to the login screen.
- Session expiry while the app is open (detected by an API request returning an authentication error) → redirect to login with message: `"Sitzung abgelaufen. Bitte erneut anmelden."` **[C]**
- The login screen is the **only** view available to unauthenticated users. No project data is accessible without authentication.
- After logout, the browser back button must **not** reveal project data.

### 9.5 Asynchronous Mutation Behavior

Mutations (state transitions, date updates) go through the API (see [API](api.md)). The UI must handle:

- **Loading state**: brief indicator (disabled button, spinner) while mutation is in flight. No double-submit on the same project.
- **Optimistic update**: the UI may update locally before the server responds, but must reconcile with the server response (revert on failure).
- **Error feedback**: failed mutation shows German-language error message, reverts local state. `"Änderung fehlgeschlagen. Bitte erneut versuchen."` **[C]**

### 9.6 Theme Handling

The application renders in light or dark color scheme based on the user's theme preference (see [data-model.md §5.7](data-model.md#57-user-theme-preference)).

- **Authoritative source**: the server value on `UserAccount.themePreference`. The client mirrors the preference value locally only to avoid a flash of the wrong theme on page load.
- **Local cache semantics**: the cache holds the preference value (`'light' | 'dark' | 'system'`), not the resolved light/dark scheme. When the cached value is `'system'`, the client resolves the scheme from the operating system at each render.
- **Initial resolution** (before first paint): the client reads its local cache; if absent, it falls back to the operating-system `prefers-color-scheme`. This runs before themed content is first painted.
- **Session hydration**: after the authenticated session is established, the client replaces the local cache with the server value and re-applies the theme.
- **`'system'` mode**: the client subscribes to operating-system color-scheme changes and updates the UI without a reload.
- **Updates**: the user selects a theme via the user menu ([§8.7.2](#872-user-menu)). The selection is sent to the server via the self-update operation ([api.md §14.2.1](api.md#1421-authentication)) and applied optimistically — a failed mutation reverts the local theme per [§9.5](#95-asynchronous-mutation-behavior).
- **Unauthenticated screens**: the login screen and insecure banner follow the client's initial resolution (local cache or operating-system preference); no server value is available yet.
- **Logout and session expiry**: the local cache is retained across logout so the returning user does not see a theme flash at the login screen. Logging in as a different user replaces the cache on the next session hydration.

### 9.7 Modal Interaction

All modals close on Escape (equivalent to the cancel action). Form modals submit the primary action on Enter when focus is within the form. Modals without a primary action — read-only detail views, success-state confirmations — accept Escape but do not submit on Enter.

Form modals and confirmation dialogs do not close on backdrop click — only via Escape or the explicit cancel action. Non-editing side panels close on backdrop click as the cancel equivalent.

---

## 10. Responsive Behavior

The Kanban board uses a progressive column collapse to remain usable on narrower viewports. Columns are grouped into three tiers by priority. Action columns are always the last to collapse.

- **Below 1780px** — tier-3 columns collapse: Angebot, Abgerechnet, Erledigt. Collapsed columns show a slim indicator with the column header and card count. Cards are hidden.
- **Below 1350px** — tier-2 columns also collapse: Geplant, In Arbeit, Abnahme.
- **Below 940px** — tier-1 columns also collapse: Anfrage, Beauftragt, Rechnung fällig. Action columns are always the last to collapse.
- **Expanding**: clicking a collapsed column expands it. Clicking the column header again collapses it.

---

_Cross-references: [index.md](index.md) for workflow states and assumptions, [data-model.md](data-model.md) for entity definitions and state metadata, [api.md](api.md) for API operations, [verification.md](verification.md) for acceptance criteria._
