# Product Specification

**Source documents:** [Kickoff](../project/kickoff.md), [Plan](../project/plan.md)

---

## 1. Goal

Deliver a hosted, authenticated system that demonstrates a consolidated preview of the state of all projects across the main company workflow. The system persists data in a database, authenticates users, serves the front end through a backend API, and stores binary assets in object storage. It provides two complementary views — a **Kanban board** and a **Calendar** — with basic interactivity.

This iteration must answer two questions:

> "Can this system persist and retrieve real project data without losing the interaction model validated in iteration 1?"

> "Can access be restricted to authenticated users in a way that supports later role-based views and permissions without forcing a rewrite?"

### 1.1 Iteration History

| Iteration | Focus | Status |
|---|---|---|
| 1 | Walking skeleton — front-end prototype with mock data, Kanban + Calendar views | Accepted |
| 2 | Persistence (database + API), authentication, object storage | Accepted |
| 3 | Stabilization — structural refactor, maintainability overhaul, test expansion | Accepted |
| 4 | Deployment, integration testing, CD pipeline, VPN access | **Current** |

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
- All company-specific values configurable
- API layer between front end and data store
- Persistent data storage in a database
- Seed data providing a realistic starting snapshot
- User authentication (login/logout, session management)
- Object storage module encapsulating all binary storage operations (prepared for future file uploads — no upload UI in this iteration)
- Deployment to a hosted environment (application, database, object storage)
- Continuous delivery pipeline (auto-deploy on merge to main)

### 2.2 Out of Scope

- Role-based access control beyond basic authenticated/unauthenticated distinction
- User self-registration
- Password reset / forgot-password flow
- SSO / OAuth / external identity providers
- Project creation or deletion (UI)
- Field editing beyond status and dates
- File uploads (storage module is prepared, but no upload UI)
- Notifications (email, WhatsApp)
- Worker view, bookkeeper view
- Mobile optimization
- Print or export
- i18n framework (German only, hardcoded strings are fine)

---

## 3. Workflow States

The Kanban board reflects the full company workflow. The number and definition of states are driven by configuration — the system does not hardcode a specific state count or state names.

The current configuration defines 9 states:

| # | State | Type | Description |
|---|---|---|---|
| 1 | **Anfrage** | Action | Inquiry received — company must write an offer |
| 2 | **Angebot** | Buffer | Offer sent — waiting for customer confirmation |
| 3 | **Beauftragt** | Action | Customer confirmed — company must plan and schedule |
| 4 | **Geplant** | Buffer | Planned — waiting for its turn on the calendar |
| 5 | **In Arbeit** | Active | Being executed (incl. Aufmaß, photos, etc.) |
| 6 | **Abnahme** | Buffer | Execution complete — waiting for customer acceptance |
| 7 | **Rechnung fällig** | Action | Customer accepted — company must write the invoice |
| 8 | **Abgerechnet** | Buffer | Invoice sent — waiting for payment |
| 9 | **Erledigt** | Done | Payment received — project closed |

Three action states, four buffer states, one active, one terminal. The Kanban board makes action states naturally visible — items accumulating in an action column signal that work is falling behind.

**[C]** The state set (names, types, order, count) is configurable per company. Adding or removing states must not require code changes beyond updating the configuration.

---

## 4. Reasonable Assumptions

All assumptions are candidates for later configuration, marked **[C]**.

### 4.1 Company Profile

| Attribute | Assumed Value |
|---|---|
| Trade | Maler- und Lackiererbetrieb (painter / coating contractor) **[C]** |
| Employees | Owner, 1 office manager, 4–6 workers, 1 external bookkeeper **[C]** |
| Concurrent active projects | 10–30 **[C]** |
| Typical project duration | 1–10 working days **[C]** |
| Region | Single metropolitan area (~50 km radius) **[C]** |

### 4.2 Users

The system introduces authenticated access.

The only fully implemented interactive perspective is the **Owner / Office Manager** operational view. All authenticated users see all projects and can perform the same state and date changes. This is a deliberate simplification, not a statement about the final authorization model.

**Assumptions [C]:**
- Initial deployments may start with a very small user set (e.g. 1–5 named users) **[C]**
- The system must support migration from simple access rules to role-based authorization later without changing the domain model **[C]**
- Self-registration is not available — users are created by an administrator (or via seed data for this iteration) **[C]**

### 4.3 Scheduling

Each project has at most one planned date range (start/end) representing the main execution slot. Detailed crew or resource planning is deferred.

### 4.4 Data Origin

All data is stored in a persistent database, accessed through an API layer. On first deployment, seed data (see [Data Model — Seed Data](data-model.md#7-seed-data-specification)) is loaded to provide the same realistic starting point as the walking skeleton's mock data.

### 4.5 Authentication

| Attribute | Assumed Value |
|---|---|
| Authentication method | Username + password **[C]** |
| Password policy | Minimum 8 characters **[C]** |
| Session duration | 24 hours **[C]** |
| Maximum concurrent sessions per user | Unlimited **[C]** |
| Default admin account | Environment-variable bootstrap on first run (`BOOTSTRAP_ADMIN_*`) — see [ADR-0010](../adr/0010-first-run-admin-bootstrap.md) |
| Self-registration | Not available **[C]** |

The system does not implement a user management UI in this iteration. For development, initial users come from seed data (see [data-model.md §7.2](data-model.md#72-seed-users)). For production, the first admin account is created by the first-run bootstrap mechanism (see [ADR-0010](../adr/0010-first-run-admin-bootstrap.md)): set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` on first deploy, log in, change the password, remove the env vars, redeploy. Subsequent users are added administratively (direct database write in this iteration). A user management interface is planned for a later iteration (see kickoff: "administrator's view").

---

## Spec Structure

This specification is split across multiple files:

| File | Sections | Contents |
|---|---|---|
| **[index.md](index.md)** (this file) | 1–4 | Goal, scope, workflow states, assumptions |
| **[data-model.md](data-model.md)** | 5–7 | Project, User, Session entities; state metadata; persistence principles; seed data |
| **[ui.md](ui.md)** | 8–10 | Layout, views, interactions, login, async mutation UX |
| **[architecture.md](architecture.md)** | 11–13 | Responsibility layers, dependencies, extensibility, configuration, NFRs, security |
| **[api.md](api.md)** | 14 | API design principles, operations, authorization, error handling |
| **[verification.md](verification.md)** | 15–18 | Acceptance criteria, test specifications, risks, open questions |

---

## Iteration Scope vs. Vision

Mapping of features from the [kickoff "Done when" list](../project/kickoff.md) to their target iteration. Iteration 2 features are marked Done; future features show their earliest target.

| Feature | Status | Iteration |
|---------|--------|-----------|
| Kanban view with state columns and basic interactivity | Done | 1 |
| Calendar overview for planning | Done | 1 |
| Persistent data storage (database + API) | Done | 2 |
| User authentication (login/logout, sessions) | Done | 2 |
| Object storage module (prepared for uploads) | Done | 2 |
| Structural refactor and maintainability overhaul | Done | 3 |
| Deployment to hosted environment | Planned | 4 |
| Continuous Delivery pipeline | Planned | 4 |
| End-to-end tests on all integrations (CI) | Planned | 4 |
| LLM-based customer data extraction from emails | Planned | 5+ |
| All customer and project data managed in central system | Planned | 5+ |
| Worker view (relevant projects, calendar, object data, GPS) | Planned | 5+ |
| Worker uploads (notes, photos, Aufmass) | Planned | 5+ |
| Binary file optimization and space alerts | Planned | 6+ |
| Configurable event notifications (email, optional WhatsApp) | Planned | 6+ |
| Modular architecture with open-standard data exchange | Planned | 5+ |
| Bookkeeper view (invoices, search, grouping, export) | Planned | 6+ |
| Administrator view (users, groups, rights) | Planned | 5+ |
| German user manual ("Handbuch") | Planned | 6+ |
| Tooltips, hints, and in-app help | Planned | 6+ |

---

## Known Debt

Items marked as "Known debt" across the specification. Each will be resolved or re-assessed when its target iteration begins.

| Item | Location | Target Iteration | Issue |
|------|----------|-----------------|-------|
| `customer` is inline (denormalized) — extract to `Customer` entity | [data-model.md §5.1](data-model.md#51-project-entity) | 4+ | TBD |
| `assignedWorkers` is `string[]` of display names — replace with `Worker` entity references | [data-model.md §5.1](data-model.md#51-project-entity) | 4+ | [#53](https://github.com/vlzware/Projekt-Manager/issues/53) |
| Minimal role set — add fine-grained permissions and per-role view restrictions | [data-model.md §5.3](data-model.md#53-user-entity) | 4+ | TBD |
| No link between `UserAccount` and `Project.assignedWorkers` | [data-model.md §5.3](data-model.md#53-user-entity) | 4+ | [#53](https://github.com/vlzware/Projekt-Manager/issues/53) |
| Password change does not invalidate existing sessions | [data-model.md §5.4](data-model.md#54-session) | 4+ | TBD |
| State actions mutate silently — need middleware or event hooks for audit trail and notifications | [architecture.md §11.3](architecture.md#113-state-layer-behavioral-contract) | 4+ | TBD |

---

*Living document — updated as each iteration ships. Git history preserves past versions.*
