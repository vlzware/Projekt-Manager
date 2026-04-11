# Verification

---

## 15. Acceptance Criteria

The system is accepted when all of the following are true.

### 15.1 Core

- **AC-1**: The full stack (frontend, backend, database) starts locally with a documented command or minimal command sequence.
- **AC-2**: Kanban view renders 9 columns with all projects in their correct states.
- **AC-3**: Calendar view renders projects with planned dates as colored bars on a month grid.
- **AC-4**: Clicking a project in either view opens the detail panel with all available fields.
- **AC-5**: The [→] button transitions a project to the next state, with a German confirmation dialog. The card moves to the correct column. The change persists across page reloads.
- **AC-6**: Backward transition via the detail panel moves a project to the previous state. The change persists across page reloads.
- **AC-7**: Changing a date in the detail panel updates `plannedStart`/`plannedEnd` and is reflected in both views. The change persists across page reloads.
- **AC-8**: Summary area shows counts for action states and aged buffer items.
- **AC-9**: Clicking a summary indicator filters the view to affected projects.
- **AC-10**: "X Projekte ohne Termin" counter appears below the calendar.

### 15.2 Visual

- **AC-11**: Action columns are visually distinct from buffer columns.
- **AC-12**: Each state has a consistent color across Kanban dots, calendar bars, and detail badge.
- **AC-13**: Aged buffer items show a `"seit X Tagen"` indicator.
- **AC-14**: Cards display project number, title, customer, dates (or "Kein Termin").
- **AC-15**: Every card shows its `statusChangedAt` date. The date turns bold when the configured aging threshold is exceeded.

### 15.3 Behavioral

- **AC-16**: State transitions only allow forward +1 or backward -1. No skipping.
- **AC-17**: `Erledigt` is terminal — both transition buttons are hidden.
- **AC-18**: `Anfrage` hides the backward transition button.
- **AC-19**: Display dates use German format (DD.MM.YYYY). Date input controls respect the user's browser locale. Calendar week starts Monday.
- **AC-20**: UI does not crash on projects with missing optional fields.
- **AC-53**: A failed mutation displays a German error message and reverts the optimistic UI update.

### 15.4 Authentication

- **AC-21**: Unauthenticated users see only a login screen. No project data is accessible.
- **AC-22**: Entering valid credentials and clicking "Anmelden" logs the user in and shows the Kanban view.
- **AC-23**: Entering invalid credentials shows a generic error message in German.
- **AC-24**: The user's display name is shown in the header.
- **AC-25**: Clicking "Abmelden" logs the user out and returns to the login screen.
- **AC-26**: After logout, pressing the browser back button does not reveal project data.
- **AC-27**: A session that expires while the app is open redirects to login with an expiry message.
- **AC-28**: A request with a valid session token for a deactivated user is rejected with an authentication error.
- **AC-52**: An authenticated user can change their own password. A change attempt with an incorrect current password is rejected.

### 15.5 Multi-User

- **AC-29**: Two users logged in simultaneously see each other's changes after refreshing.

### 15.6 Deployment

- **AC-30**: The application is reachable by authorized clients over HTTPS. HTTPS is non-negotiable (see AC-45). Network reachability is scoped by [ADR-0008](../adr/0008-vpn-first-network-access.md); see also AC-49.
- **AC-31**: A CI-built image can be promoted to the hosted environment via manual, pull-based deploy over WireGuard (see [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)).
- **AC-45**: HTTPS is the default transport. HTTP is never a silent fallback — it is an explicit, deliberately ugly opt-in used only in environments where TLS is unavailable (see [ADR-0013](../adr/0013-http-only-evaluation-mode.md) — VPN does not substitute for TLS, per [ADR-0008](../adr/0008-vpn-first-network-access.md)). The opt-in has four parts that must all hold together:
  1. **Default**: port 80 redirects to HTTPS before any application handler runs, or is not bound at all. No server route ever runs over plain HTTP in the default configuration.
  2. **Opt-in**: HTTP mode is selected only when `ALLOW_INSECURE_HTTP=true` AND `NODE_ENV` is not `production`. Neither flag alone is sufficient. In HTTP mode the server disables the `Secure` cookie flag and relaxes CSP — operators must understand that credentials travel in cleartext.
  3. **Visible**: when HTTP mode is active, the UI renders a red, non-dismissible full-width banner on every page reading `"UNSICHERER MODUS — Keine Verschlüsselung, Zugangsdaten werden im Klartext übertragen"`, and the browser tab title is prefixed with `UNSICHER –`. The banner covers both the login screen and the authenticated layout.
  4. **Production refusal**: `ALLOW_INSECURE_HTTP=true` with `NODE_ENV=production` causes the server to refuse to start. `NODE_ENV` defaults to `production` in the validated environment schema so an unset value hits the safer branch.
- **AC-46**: A failed deployment leaves the previously running version running. `scripts/deploy.sh` aborts before swapping containers if the image pull, the compose-up, or the health-check loop fails; the operator sees a loud failure and the current containers keep serving traffic.
- **AC-47**: A previously deployed commit can be redeployed (rollback) by the operator invoking `scripts/deploy.sh <sha>` on the VPS over WireGuard, where `<sha>` is any previously built image tag in GHCR. No code change and no workflow re-run are required — only operator presence on the host per [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md). The operator is also the only party who can decrypt the age-wrapped secrets the script needs, so rollback authority is tied to WireGuard + passphrase rather than a GitHub credential.
- **AC-48**: After every `scripts/deploy.sh` invocation, an automated smoke test polls `/api/health` against the freshly started container. Failure of the smoke test aborts the deploy and surfaces the failure to the operator.
- **AC-49**: Network access to the hosted environment is restricted to authorized clients via VPN per [ADR-0008](../adr/0008-vpn-first-network-access.md). The application is not reachable from the public internet without VPN credentials.
- **AC-50**: Database and object storage data persist across application container restarts and redeploys. A redeploy of the application containers does not wipe project, user, or session data.
- **AC-51**: Deployments use a specific commit SHA, not a moving tag. The deployed version is reproducible and traceable to a single commit.

### 15.7 Engineering

- **AC-32**: Code is structured into the modules defined in [architecture.md §11.2](architecture.md#112-responsibility-boundaries).
- **AC-33**: All data mutations go through the API. The state layer dispatches to the API; UI components never call the API directly.
- **AC-34**: State configuration (labels, colors, thresholds) is centralized in `config/`.
- **AC-35**: Dependency direction ([architecture.md §11.2](architecture.md#112-responsibility-boundaries)) is enforced — no reverse imports.
- **AC-36**: Linting and formatting pass.
- **AC-37**: Tests defined in section 16 pass. Coverage is split across two execution surfaces so the push/PR gate stays fast:
  - **Push/PR gate**: unit tests (§16.1), component tests (§16.2), API integration tests (§16.3), and the server-side supplementary tests (§16.5) run on every push and PR to protected branches. A failing test at this layer blocks merge.
  - **On-demand E2E gate**: Playwright §16.4 + the E2E supplementary tests from §16.5 run on a manual trigger, typically before a manual deploy per [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md). Playwright is not part of the push/PR gate (see [architecture.md §11.7](architecture.md#117-continuous-delivery-pipeline) for the CI topology).
  - **Local dev**: `npm run test` and `npm run test:e2e` run locally and are part of the Definition of Done for any change that touches their respective code paths.

### 15.8 Configurability

- **AC-38**: App name (header) and footer text are driven by a branding config, not hardcoded in components. Changing the config changes all instances.
- **AC-39**: Authentication parameters (session duration) are driven by configuration.

### 15.9 Infrastructure

- **AC-40**: Object storage module successfully uploads and retrieves a file in the deployed environment (see [architecture.md §11.4](architecture.md#114-object-storage-module)).

### 15.10 Responsive

- **AC-41**: At viewport widths below 1780px, tier-3 columns (Angebot, Abgerechnet, Erledigt) collapse to slim indicators showing the column header and card count. Cards are hidden.
- **AC-42**: At viewport widths below 1350px, tier-2 columns (Geplant, In Arbeit, Abnahme) also collapse.
- **AC-43**: At viewport widths below 940px, tier-1 columns (Anfrage, Beauftragt, Rechnung fällig) also collapse. Action columns are always the last to collapse.
- **AC-44**: Clicking a collapsed column expands it. Clicking the column header again collapses it.

---

## 16. Test Specification

### 16.1 Unit Tests

- **UT-1**: Aging calculation — returns correct `"seit X Tagen"` for a buffer project exceeding threshold.
- **UT-2**: Aging calculation — returns nothing for a project below threshold.
- **UT-3**: Aging bold — returns true for an action-state project exceeding `agingBoldDays`.
- **UT-4**: State transition — `getNextState('geplant')` returns `'in_arbeit'`.
- **UT-5**: State transition — `getNextState('erledigt')` returns `null`.
- **UT-6**: State transition — `getPreviousState('anfrage')` returns `null`.
- **UT-7**: State transition — `getPreviousState('erledigt')` returns `null`.
- **UT-8**: Summary computation — correctly counts projects per action state.
- **UT-9**: Summary computation — correctly counts aged buffer items.
- **UT-10**: Password hashing — a hashed password does not match a different plaintext.
- **UT-11**: Password hashing — a hashed password matches the original plaintext.
- **UT-12**: Session expiry — a session past its `expiresAt` is treated as invalid.

### 16.2 Component Tests

These tests run against a mocked API.

- **CT-1**: Kanban board renders 9 columns with correct German labels.
- **CT-2**: Kanban board distributes projects into correct columns.
- **CT-3**: Project card displays number, title, customer, date range, entry date.
- **CT-4**: Project card shows "Kein Termin" when dates are missing.
- **CT-5**: Project card shows bold entry date when aging threshold exceeded.
- **CT-6**: Clicking a card opens the detail panel.
- **CT-7**: [→] button triggers state change and moves card to next column.
- **CT-8**: [→] button is hidden on `Erledigt` cards.
- **CT-9**: Backward transition via detail panel moves card to previous column.
- **CT-10**: Backward button is hidden for `Anfrage` and `Erledigt`.
- **CT-11**: Calendar renders projects with dates as colored bars.
- **CT-12**: Calendar renders single-date project as single-day block.
- **CT-13**: Summary area updates after a state change.
- **CT-14**: Clicking a summary indicator filters the Kanban to matching projects.
- **CT-15**: "Filter aufheben" button clears the filter.
- **CT-16**: "X Projekte ohne Termin" counter appears below calendar.
- **CT-17**: Changing dates in detail panel updates calendar bar position.
- **CT-18**: Login form renders username, password fields, and submit button.
- **CT-19**: Submitting valid credentials calls the login API and navigates to the main view.
- **CT-20**: Submitting invalid credentials shows an error message without navigating.
- **CT-21**: User indicator in header shows display name.
- **CT-22**: Clicking "Abmelden" calls the logout API and shows the login screen.
- **CT-23**: When a mutation API call fails, the UI shows an error message and reverts local state.
- **CT-24**: While a mutation is in flight, the triggering control is disabled (no double-submit).

### 16.3 API Integration Tests

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

### 16.4 E2E Tests

The end-to-end path is covered by focused, isolated test files rather than a single monolithic scenario. This improves test isolation, failure diagnostics, and net-zero teardown. The steps below define the required behavioral coverage; the implementation may split them across multiple test files and specs.

**Smoke (login/logout cycle)**:

1. App loads — login screen is displayed.
2. User enters credentials and logs in — Kanban view is displayed with 9 columns.
3. Header shows user's display name.
4. User clicks "Abmelden" — login screen appears.

**Kanban flows (state transitions, dates, calendar, persistence)**: 4. Summary area shows `"3× Rechnung fällig"`. 5. User clicks a summary indicator — view filters to matching projects. 6. User clicks "Filter aufheben" — full view restored. 7. User clicks a card in `Geplant` — detail panel opens. 8. User clicks "Nächster Schritt" — confirmation dialog appears. 9. User confirms — card moves to `In Arbeit`. 10. User clicks "Vorheriger Schritt" on the same card — card moves back to `Geplant`. 11. User changes planned end date via date picker in detail panel. 12. User switches to calendar view — the project bar reflects the new date. 13. User clicks "X Projekte ohne Termin" — switches to filtered Kanban. 14. Summary area reflects current state counts throughout. 15. User refreshes the page — changes persist; user remains logged in. 17. Pressing browser back button after logout does not show project data.

### 16.5 Supplementary Tests

Tests providing coverage beyond the core specification. These are not mapped to specific spec IDs but verify important behaviors.

#### Server-side

- Bootstrap: first-run admin creation via `BOOTSTRAP_ADMIN_*` env vars
- Bulk import: partial success, validation per item, permission enforcement
- Events: domain event bus subscribe/emit, error isolation
- Health probe: DB and storage liveness checks
- Permissions: role-based access control matrix (4 roles)
- Rate limiting: login throttling (429 on excess attempts)
- DB constraints: CHECK constraint enforcement (`projects_end_requires_start`)
- Single project GET: by ID, not-found handling

#### Client-side

- API client: typed fetch wrappers, error paths, session expiry detection
- Project store: optimistic updates, rollback on failure, session delegation
- Confirm dialog: rendering, accessibility, focus trap
- Collapse tier hook: responsive breakpoint calculations
- Transition hook: canForward/canBackward, confirm flow
- Router navigation: helper behavior
- Date input value: normalization for HTML date inputs
- Insecure connection: HTTP-mode detection

#### E2E

- Kanban flows: summary filter, transitions, date editing, calendar, persistence, back-button protection (covers spec §16.4 steps 4–15, 17 in split tests)
- Failure paths: network errors, session expiry mid-flow
- Startup: health endpoint verification, seed login
- Insecure banner: HTTP-mode warning display

---

## 17. Risks and Mitigations

| Risk                                        | Impact                             | Mitigation                                                                                                                        |
| ------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 9 Kanban columns too tight on screen        | Usability                          | Horizontal scroll; responsive collapse tiers ([ui.md §10](ui.md#10-responsive-behavior)).                                         |
| Over-styling action columns                 | Defeats Kanban principle           | Trust board structure; resist decorative urgency.                                                                                 |
| API latency makes transitions feel sluggish | Interaction feels unresponsive     | Optimistic UI updates + sub-300ms API target ([architecture.md §13.2](architecture.md#132-performance)).                          |
| Session management edge cases               | User loses work or sees stale data | Sessions are checked on every API call. Expiry redirects to login cleanly. All mutations are immediate (no local drafts to lose). |
| Seed data dates become stale over time      | Demo loses impact                  | Dates are relative to deployment date ([data-model.md §7.4](data-model.md#74-date-range)). A re-seed operation refreshes them.    |
