# Product Specification

**Source documents:** [Kickoff](../project/kickoff.md), [Plan](../project/plan.md)

---

## 1. Goal

Deliver a hosted, authenticated system that demonstrates a consolidated preview of the state of all projects across the main company workflow. The system persists structured data in a database, authenticates users via a 4-role permission matrix (see [§4.2](#42-users)), and serves the front end through a backend API. Binary/object storage is **wired as an infrastructure module and health-probed**, but no user-facing upload path is in scope — see [architecture.md §11.4](architecture.md#114-object-storage-module). The system provides two complementary views — a **Kanban board** and a **Calendar** — with basic interactivity.

---

## 2. Scope

- Kanban board with one column per workflow state
- Calendar view (month) showing scheduled projects
- Project detail panel accessible from both views
- State transitions (forward/backward by one step)
- Date changes (planned start/end)
- Summary area with aggregate indicators
- German UI, English code
- API layer between front end and data store
- Persistent data storage in a database
- Seed data providing a realistic starting snapshot
- User authentication (login/logout, session management) with a 4-role permission matrix ([§4.2](#42-users))
- Object storage module encapsulating all binary storage operations (see [architecture.md §11.4](architecture.md#114-object-storage-module))
- Deployment to a hosted environment (reverse proxy, application, database, object storage)
- CI builds images and pushes to GHCR; manual pull-based deploy over WireGuard per [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)

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

**[C]** The state set (names, types, order, count) is defined in a single configuration array; the `WorkflowState` type is derived from it. Adding or removing states requires updating the array and any boundary-state references in the domain layer, plus a database migration if the default status changes.

---

## 4. Reasonable Assumptions

### 4.1 Company Profile

| Attribute                  | Assumed Value                                               |
| -------------------------- | ----------------------------------------------------------- |
| Trade                      | Maler- und Lackiererbetrieb (painter / coating contractor)  |
| Employees                  | Owner, 1 office manager, 4–6 workers, 1 external bookkeeper |
| Concurrent active projects | 10–30                                                       |
| Typical project duration   | 1–10 working days                                           |
| Region                     | Single metropolitan area (~50 km radius)                    |

### 4.2 Users

The system is authenticated and implements a **four-role permission matrix**. The roles — `owner`, `office`, `worker`, `bookkeeper` — are defined in [`src/server/config/permissions.ts`](../../src/server/config/permissions.ts) and enforced server-side on every protected route via `requirePermission()`. See [api.md §14.3](api.md#143-authorization-rules) for the full role ↔ permission mapping.

- **Owner** and **office** carry full read + write permissions on projects (list, get, forward and backward transitions, date edits, bulk import) plus change-own-password.
- **Worker** and **bookkeeper** are read-only on projects (list, get) plus change-own-password.
- Self-registration is not available — users are created by an administrator, by seed data, or by the first-run bootstrap (see [§4.5](#45-authentication)).

The role set and per-role permission list are configurable in `permissions.ts` **[C]**.

### 4.3 Scheduling

Each project has at most one planned date range (start/end) representing the main execution slot. Detailed crew or resource planning is deferred.

### 4.4 Data Origin

All data is stored in a persistent database, accessed through an API layer. Seed data (see [data-model.md §7](data-model.md#7-seed-data-specification)) is loaded **only when `NODE_ENV` is not `production`** — the production start-up path in [`src/server/start.ts`](../../src/server/start.ts) deliberately skips seeding to avoid overwriting real data on a first deploy. Dev and test workflows use `SEED=true` (or `SEED=force` to wipe and reload) to reach the starting snapshot.

### 4.5 Authentication

| Attribute                            | Assumed Value                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication method                | Username + password                                                                                                                   |
| Password policy                      | Min 8 characters, max 72 UTF-8 bytes, common-password blocklist **[C]**                                                               |
| Session duration                     | 24 hours **[C]**                                                                                                                      |
| Maximum concurrent sessions per user | Unlimited                                                                                                                             |
| Default admin account                | Environment-variable bootstrap on first run (`BOOTSTRAP_ADMIN_*`) — see [ADR-0010](../adr/0010-first-run-admin-bootstrap.md)          |
| Self-registration                    | Not available                                                                                                                         |
| Password-change side effect          | Invalidates every **other** session for the same user (current session survives) — see [data-model.md §5.4](data-model.md#54-session) |

**Password policy detail.** The minimum length is 8 characters (policy) but bcrypt truncates input at 72 UTF-8 bytes — the system enforces a hard ceiling there so long inputs fail loudly rather than silently ignoring bytes past the truncation point. A blocklist of common passwords (`src/server/data/common-passwords.ts`) is checked on every password set to reject trivially guessable values. Both checks run through the same `checkPasswordPolicy()` so the bootstrap path and the change-password endpoint cannot diverge. See [ADR-0006](../adr/0006-password-policy-nist-blocklist.md).

For development, initial users come from seed data (see [data-model.md §7.2](data-model.md#72-user-dataset)). For production, the first admin account is created by the first-run bootstrap mechanism (see [ADR-0010](../adr/0010-first-run-admin-bootstrap.md)); subsequent users are added administratively.

---

## Spec Structure

This specification is split across multiple files:

| File                                   | Sections | Contents                                                                             |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| **[index.md](index.md)** (this file)   | 1–4      | Goal, scope, workflow states, assumptions                                            |
| **[data-model.md](data-model.md)**     | 5–7      | Project, User, Session entities; state metadata; persistence principles; seed data   |
| **[ui.md](ui.md)**                     | 8–10     | Layout, views, interactions, login, async mutation UX                                |
| **[architecture.md](architecture.md)** | 11–13    | Responsibility layers, dependencies, extensibility, configuration, NFRs, security    |
| **[api.md](api.md)**                   | 14       | API design principles, operations, authorization, error handling                     |
| **[verification.md](verification.md)** | 15–19    | Acceptance criteria, test specifications, traceability matrix, risks, open questions |

**Notation.** `[C]` marks values that are centralized in `src/config/` (or equivalent) and may vary per deployment. Catalogue: [architecture.md §12.2](architecture.md#122-company-configurable-settings).
