# Product Specification

**Source documents:** [Kickoff](../project/kickoff.md), [Plan](../project/plan.md)

---

## 1. Goal

Deliver a hosted, authenticated system that demonstrates a consolidated preview of the state of all projects across the main company workflow. The system persists structured data in a database, authenticates users via a 4-role permission matrix (see [§4.2](#42-users)), and serves the front end through a backend API. Binary/object storage is **wired as an infrastructure module and health-probed**, but no user-facing upload path is in scope for this iteration — see [§2.2](#22-not-in-this-iteration) and [architecture.md §11.4](architecture.md#114-object-storage-module). The system provides two complementary views — a **Kanban board** and a **Calendar** — with basic interactivity.

Previous iterations answered two foundational questions (both resolved affirmatively):

> "Can this system persist and retrieve real project data without losing the interaction model validated in iteration 1?" _(answered: iteration 2)_

> "Can access be restricted to authenticated users in a way that supports later role-based views and permissions without forcing a rewrite?" _(answered: iteration 2)_

The current iteration (5 — Consolidation) focuses on spec-code reconciliation, quality controls, and security review.

### 1.1 Iteration History

| Iteration | Focus                                                                          | Status      |
| --------- | ------------------------------------------------------------------------------ | ----------- |
| 1         | Walking skeleton — front-end prototype with mock data, Kanban + Calendar views | Accepted    |
| 2         | Persistence (database + API), authentication, object storage                   | Accepted    |
| 3         | Stabilization — structural refactor, maintainability overhaul, test expansion  | Accepted    |
| 4         | Deployment, integration testing, CD pipeline, VPN access                       | Accepted    |
| 5         | Consolidation — spec-code reconciliation, quality controls, security review    | **Current** |

---

## 2. Scope

### 2.1 In Scope

- Kanban board with one column per workflow state
- Calendar view (month) showing scheduled projects
- Project detail panel accessible from both views
- State transitions (forward/backward by one step)
- Date changes (planned start/end)
- Summary area with aggregate indicators
- German UI, English code
- Company-specific values configurable **where marked `[C]` in this spec** — iteration 5 centralizes branding (app name, footer text), state configuration (labels, colors, thresholds, collapse tiers), German UI strings, and date/locale display. Values such as project numbering format, company profile assumptions, and authentication parameters are defined as single-source constants but not yet runtime-configurable; the per-item status is in [§12.2](architecture.md#122-company-configurable-settings-c)
- API layer between front end and data store
- Persistent data storage in a database
- Seed data providing a realistic starting snapshot
- User authentication (login/logout, session management) with a 4-role permission matrix ([§4.2](#42-users))
- Object storage module encapsulating all binary storage operations (prepared for future file uploads — no upload UI in this iteration, see [§1](#1-goal) and [architecture.md §11.4](architecture.md#114-object-storage-module))
- Deployment to a hosted environment (reverse proxy, application, database, object storage)
- CI builds images and pushes to GHCR; manual pull-based deploy over WireGuard per [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md) (see also [§2.3](#23-changes-since-the-kickoff) for the departure from the kickoff's CD requirement)

### 2.2 Not in this iteration

Items below are **part of the project vision per the [kickoff](../project/kickoff.md)** but not yet implemented in iteration 5. They are not out of scope — they are sequenced to later iterations. Removing or substituting one from the kickoff is a separate decision, tracked in [§2.3](#23-changes-since-the-kickoff).

- Fine-grained RBAC beyond the current 4-role matrix — per-role view restrictions (e.g. worker sees only assigned projects, bookkeeper sees only invoices) and configurable per-customer role sets are deferred. The 4-role permission matrix itself is implemented — see [§4.2](#42-users) and [api.md §14.3](api.md#143-authorization-rules).
- User self-registration (kickoff does not require it; left deferred for symmetry with other auth flows)
- Password reset / forgot-password flow
- SSO / OAuth / external identity providers
- Project creation and deletion (UI) — bulk import API exists; single-item create/delete UI deferred
- Field editing beyond status and dates
- File uploads (storage module is prepared and health-probed, but no upload UI)
- Notifications (email, optional WhatsApp)
- Worker view
- Bookkeeper view
- Administrator view (user management UI — direct DB writes only for now, plus `BOOTSTRAP_ADMIN_*` first-run)
- Customer-data extraction from emails via LLM
- German user manual ("Handbuch")
- In-app tooltips, hints, and contextual help
- Mobile optimization
- Print or export

### 2.3 Changes since the kickoff

Two items differ from the kickoff's "Done when" list:

- **Continuous Delivery replaced by manual pull-based deploy.** The kickoff lists CD as a done-when requirement. Iteration 4 evaluated CD against the VPN-first topology ([ADR-0008](../adr/0008-vpn-first-network-access.md)) and the lack of a stable inbound path to the target host, and replaced auto-deploy with a manual, operator-invoked pull over WireGuard ([ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)). Each deployed image is still built in CI and pinned to a commit SHA ([ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md)) — only the "push to main → auto-deploy" loop is gone. This is the one deliberate departure from the kickoff; every other kickoff item either ships today or lives in [§2.2](#22-not-in-this-iteration).
- **Centralized German strings (addition beyond kickoff).** The kickoff specifies "internals and developer information in English, user-facing information in German" — a language convention, not a centralization mandate. In practice, UI strings are being extracted into [`src/config/strings.ts`](../../src/config/strings.ts) so future localization has a single source and spec-referenced wording (error messages, German labels) stays consistent across call sites. Extraction is in progress; some call sites still use inline literals. A full i18n framework is not planned for this iteration.

---

## 3. Workflow States

The Kanban board reflects the full company workflow. The number and definition of states are driven by configuration — the system does not hardcode a specific state count or state names.

The current configuration defines 9 states:

| #   | State               | Type   | Description                                          |
| --- | ------------------- | ------ | ---------------------------------------------------- |
| 1   | **Anfrage**         | Action | Inquiry received — company must write an offer       |
| 2   | **Angebot**         | Buffer | Offer sent — waiting for customer confirmation       |
| 3   | **Beauftragt**      | Action | Customer confirmed — company must plan and schedule  |
| 4   | **Geplant**         | Buffer | Planned — waiting for its turn on the calendar       |
| 5   | **In Arbeit**       | Active | Being executed (incl. Aufmaß, photos, etc.)          |
| 6   | **Abnahme**         | Buffer | Execution complete — waiting for customer acceptance |
| 7   | **Rechnung fällig** | Action | Customer accepted — company must write the invoice   |
| 8   | **Abgerechnet**     | Buffer | Invoice sent — waiting for payment                   |
| 9   | **Erledigt**        | Done   | Payment received — project closed                    |

Three action states, four buffer states, one active, one terminal. The Kanban board makes action states naturally visible — items accumulating in an action column signal that work is falling behind.

**[C]** The state set (names, types, order, count) is defined in a single configuration array. The `WorkflowState` type is derived from this array. Adding or removing states requires updating the configuration array, adjusting boundary-state references in the domain layer (first/last state checks), and a database migration if the default status changes. This is deliberately simple but is not a zero-code-change operation — improving this toward true zero-change configurability is tracked as a goal.

---

## 4. Reasonable Assumptions

All assumptions are candidates for later configuration, marked **[C]**.

### 4.1 Company Profile

| Attribute                  | Assumed Value                                                       |
| -------------------------- | ------------------------------------------------------------------- |
| Trade                      | Maler- und Lackiererbetrieb (painter / coating contractor) **[C]**  |
| Employees                  | Owner, 1 office manager, 4–6 workers, 1 external bookkeeper **[C]** |
| Concurrent active projects | 10–30 **[C]**                                                       |
| Typical project duration   | 1–10 working days **[C]**                                           |
| Region                     | Single metropolitan area (~50 km radius) **[C]**                    |

### 4.2 Users

The system is authenticated and implements a **four-role permission matrix**. The roles — `owner`, `office`, `worker`, `bookkeeper` — are defined in [`src/server/config/permissions.ts`](../../src/server/config/permissions.ts) and enforced server-side on every protected route via `requirePermission()`. See [api.md §14.3](api.md#143-authorization-rules) for the full role ↔ permission mapping and the spec contract the routes must honor.

Current iteration scope:

- **Owner** and **office** carry full read + write permissions on projects (list, get, forward and backward transitions, date edits, bulk import) plus change-own-password. They are the only roles that act on project state.
- **Worker** and **bookkeeper** are read-only on projects (list, get) plus change-own-password. Role-specific _views_ — a worker seeing only assigned projects on a calendar, a bookkeeper seeing only the invoice-relevant tail — are sequenced to later iterations ([§2.2](#22-not-in-this-iteration)), but the permission-check plumbing is in place today.
- Every authenticated user shares one interactive perspective in iteration 5: the owner/office operational view. Restricted roles can log in, fetch projects, and change their own password, but they do not yet have a dedicated UI surface.

**Assumptions [C]:**

- Initial deployments may start with a very small user set (e.g. 1–5 named users) **[C]**
- The role set and per-role permission list are configurable in `permissions.ts`; per-customer role sets and fine-grained permissions beyond the current 4-role matrix are deferred (see [§2.2](#22-not-in-this-iteration)) **[C]**
- Self-registration is not available — users are created by an administrator, by seed data, or by the first-run bootstrap (see [§4.5](#45-authentication)) **[C]**

### 4.3 Scheduling

Each project has at most one planned date range (start/end) representing the main execution slot. Detailed crew or resource planning is deferred.

### 4.4 Data Origin

All data is stored in a persistent database, accessed through an API layer. Seed data (see [data-model.md §7](data-model.md#7-seed-data-specification)) is loaded **only when `NODE_ENV` is not `production`** — the production start-up path in [`src/server/start.ts`](../../src/server/start.ts) deliberately skips seeding to avoid overwriting real data on a first deploy. Dev and test workflows use `SEED=true` (or `SEED=force` to wipe and reload) to reach the "walking skeleton snapshot" starting point.

### 4.5 Authentication

| Attribute                            | Assumed Value                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication method                | Username + password **[C]**                                                                                                           |
| Password policy                      | Min 8 characters, max 72 UTF-8 bytes, common-password blocklist **[C]**                                                               |
| Session duration                     | 24 hours **[C]**                                                                                                                      |
| Maximum concurrent sessions per user | Unlimited **[C]**                                                                                                                     |
| Default admin account                | Environment-variable bootstrap on first run (`BOOTSTRAP_ADMIN_*`) — see [ADR-0010](../adr/0010-first-run-admin-bootstrap.md)          |
| Self-registration                    | Not available **[C]**                                                                                                                 |
| Password-change side effect          | Invalidates every **other** session for the same user (current session survives) — see [data-model.md §5.4](data-model.md#54-session) |

**Password policy detail.** The minimum length is 8 characters (policy) but bcrypt truncates input at 72 UTF-8 bytes — the system enforces a hard ceiling there so long inputs fail loudly rather than silently ignoring bytes past the truncation point. A blocklist of common passwords (`src/server/data/common-passwords.ts`) is checked on every password set to reject trivially guessable values. Both checks run through the same `checkPasswordPolicy()` so the bootstrap path and the change-password endpoint cannot diverge. See [ADR-0006](../adr/0006-password-policy-nist-blocklist.md).

The system does not implement a user management UI in this iteration. For development, initial users come from seed data (see [data-model.md §7.2](data-model.md#72-user-dataset)). For production, the first admin account is created by the first-run bootstrap mechanism (see [ADR-0010](../adr/0010-first-run-admin-bootstrap.md)): set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` on first deploy, log in, change the password, remove the env vars, redeploy. Subsequent users are added administratively (direct database write in this iteration). A user management interface is planned for a later iteration (see kickoff: "administrator's view").

---

## Spec Structure

This specification is split across multiple files:

| File                                   | Sections | Contents                                                                           |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| **[index.md](index.md)** (this file)   | 1–4      | Goal, scope, workflow states, assumptions                                          |
| **[data-model.md](data-model.md)**     | 5–7      | Project, User, Session entities; state metadata; persistence principles; seed data |
| **[ui.md](ui.md)**                     | 8–10     | Layout, views, interactions, login, async mutation UX                              |
| **[architecture.md](architecture.md)** | 11–13    | Responsibility layers, dependencies, extensibility, configuration, NFRs, security  |
| **[api.md](api.md)**                   | 14       | API design principles, operations, authorization, error handling                   |
| **[verification.md](verification.md)** | 15–18    | Acceptance criteria, test specifications, risks, open questions                    |

---

## Iteration Scope vs. Vision

Mapping of features from the [kickoff "Done when" list](../project/kickoff.md) to their target iteration. Features through iteration 4 are marked Done; future features show their earliest target.

| Feature                                                     | Status  | Iteration |
| ----------------------------------------------------------- | ------- | --------- |
| Kanban view with state columns and basic interactivity      | Done    | 1         |
| Calendar overview for planning                              | Done    | 1         |
| Persistent data storage (database + API)                    | Done    | 2         |
| User authentication (login/logout, sessions)                | Done    | 2         |
| Object storage module (prepared for uploads)                | Done    | 2         |
| Deployment to hosted environment                            | Done    | 4         |
| CI-built images + manual pull-based deploy                  | Done    | 4         |
| End-to-end tests on all integrations (on-demand CI)         | Done    | 5         |
| LLM-based customer data extraction from emails              | Planned | Future    |
| All customer and project data managed in central system     | Planned | Future    |
| Worker view (relevant projects, calendar, object data, GPS) | Planned | Future    |
| Worker uploads (notes, photos, Aufmass)                     | Planned | Future    |
| Binary file optimization and space alerts                   | Planned | Future    |
| Configurable event notifications (email, optional WhatsApp) | Planned | Future    |
| Modular architecture with open-standard data exchange       | Planned | Future    |
| Bookkeeper view (invoices, search, grouping, export)        | Planned | Future    |
| Administrator view (users, groups, rights)                  | Planned | Future    |
| German user manual ("Handbuch")                             | Planned | Future    |
| Tooltips, hints, and in-app help                            | Planned | Future    |

---

## Known Debt

Items marked as "Known debt" across the specification. Each will be resolved or re-assessed when its target iteration begins.

| Item                                                                                                                                               | Location                                                                     | Target Iteration | Issue |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------- | ----- |
| `customer` is inline (denormalized) — extract to `Customer` entity                                                                                 | [data-model.md §5.1](data-model.md#51-project-entity)                        | Future           | TBD   |
| Minimal role set — basic permission matrix implemented (4 roles). Fine-grained permissions and per-role views remain.                              | [data-model.md §5.3](data-model.md#53-user-entity)                           | Future           | TBD   |
| State actions mutate silently — server-side event bus implemented (`events.ts`). Remaining: connect subscribers for audit trail and notifications. | [architecture.md §11.3](architecture.md#113-state-layer-behavioral-contract) | Future           | TBD   |

---

_Living document — updated as each iteration ships. Git history preserves past versions._
