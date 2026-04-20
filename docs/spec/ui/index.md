# UI Specification

Section 8 of the [product spec](../index.md): UI surface. Split into per-subsystem pages; this file carries the overall shell (§8.1 Layout, §8.7 Navigation) and the sub-TOC.

## Structure

| File                                       | Sections          | Contents                                                                     |
| ------------------------------------------ | ----------------- | ---------------------------------------------------------------------------- |
| **index.md** (this file)                   | §8.1, §8.7        | Shell: top-level layout states, navigation matrix, user menu                 |
| **[workflow-views.md](workflow-views.md)** | §8.2–§8.6         | Kanban, Calendar, Project Detail Panel, Summary, Color Coding                |
| **[management.md](management.md)**         | §8.8–§8.10, §8.13 | Project, Customer, and User management tabular CRUD views; global Audit View |
| **[daten.md](daten.md)**                   | §8.11             | Daten view — unified business-data restore + export                          |
| **[email-intake.md](email-intake.md)**     | §8.12             | Email Data Intake — modal LLM extraction to customer + project               |
| **[behavior.md](behavior.md)**             | §9, §10           | Cross-cutting behavioral rules + responsive column collapse                  |

---

## 8.1 Layout

The application has two top-level layout states depending on authentication.

### 8.1.1 Unauthenticated State

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

The server returns a generic error message on failed login — no distinction between "user not found" and "wrong password" to avoid information leakage. The client displays the server-provided message. The generic behavior is enforced server-side, not client-side.

The login screen is the **only** view available to unauthenticated users. No project data is accessible without authentication.

### 8.1.2 Authenticated State

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

- **Insecure banner**: non-dismissible, visually prominent warning shown when the page loaded over plain HTTP on a non-localhost host. Covers both login and authenticated layout. See [AC-45](../verification.md#156-deployment) and [ADR-0013](../../adr/0013-http-only-evaluation-mode.md).
- **Header**: app name **[C]**, navigation ([§8.7](#87-navigation)), summary indicators.
- **User indicator**: displays the authenticated user's `displayName`. Clicking reveals a dropdown — see [§8.7.2](#872-user-menu).
- **Mutation error banner**: appears when the most recent mutation failed. German message from the API error category (see [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)), dismiss button. Cleared on next successful mutation or by dismissal.
- **Default view**: Kanban for owner, office, worker; Projekte for bookkeeper (see [§8.7.1](#871-views)).
- **Footer**: text driven by branding config **[C]**.

---

## 8.7 Navigation

The authenticated layout provides navigation between all available views. The navigation mechanism (sidebar, top tabs, or other) is an implementation decision.

### 8.7.1 Views

| View      | Label       | Access                                                                                                                                                                                                                                                                                                                  | Default                                                  |
| --------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Kanban    | "Kanban"    | Owner, office, worker (scoped — see below). Bookkeeper: hidden.                                                                                                                                                                                                                                                         | Yes for owner, office, worker (landing view after login) |
| Calendar  | "Kalender"  | Owner, office, worker (scoped — see below). Bookkeeper: hidden.                                                                                                                                                                                                                                                         | No                                                       |
| Projects  | "Projekte"  | Owner, office, bookkeeper. Worker: hidden.                                                                                                                                                                                                                                                                              | Yes for bookkeeper (landing view after login)            |
| Customers | "Kunden"    | Owner, office, bookkeeper. Worker: hidden.                                                                                                                                                                                                                                                                              | No                                                       |
| Users     | "Benutzer"  | `user:manage` permission required (owner only under the default role set). Everyone else: hidden.                                                                                                                                                                                                                       | No                                                       |
| Daten     | "Daten"     | `data:export` permission required (owner, office under the default role set). Everyone else: hidden.                                                                                                                                                                                                                    | No                                                       |
| Audit     | "Aktivität" | `audit:read` permission required (owner, office under the default matrix). Worker and bookkeeper do not hold `audit:read` — the tab is hidden and `/audit` deep-link returns the not-permitted surface. Office visibility is narrowed by the destructive-action predicate ([api.md §14.2.8](../api.md#1428-audit-log)). | No                                                       |

**Primary / secondary header grouping.** "Benutzer", "Daten", and "Aktivität" are administration- and observability-flavored surfaces of lower daily frequency than the operational views. The header groups them under a secondary "Verwaltung" dropdown when a role sees two or more of them; a single secondary entry renders inline alongside the primary tabs (the dropdown chrome is reserved for real grouping, not one-item menus). Bookkeeper sees no secondary entries.

**Worker-scoped views.** For workers, the data presented in Kanban and Calendar is filtered to the projects the worker is assigned to — the same scoping rule that applies to the server-side list operation (see [index.md §4.2](../index.md#42-users) and [api.md §14.3](../api.md#143-authorization-rules)). The views render normally; only the row set is reduced. A project whose detail the worker is not authorized for is not reachable from a scoped Kanban or Calendar.

**Landing view.** The default landing view is Kanban for owner, office, and worker (worker scoped to assigned projects; see [§8.1.2](#812-authenticated-state)). Bookkeeper lands on Projekte, because bookkeeper does not have Kanban access under the nav matrix. A bookkeeper arriving at `/kanban` via a manual URL entry is treated under the unpermitted-route rule below rather than silently redirected.

Navigation between views preserves shared state (cached project list, customer list, authenticated user). Switching views clears any active filter.

Views that the user lacks permission to access are hidden from navigation. Server-side authorization remains authoritative — hiding is a UX convenience. A manual URL entry to a view the caller is not permitted to access presents an explicit not-permitted error surface in the client (see [AC-149](../verification.md#1521-role-scoping)) rather than a silent redirect — the client must not obscure an authorization failure behind a destination swap.

### 8.7.2 User Menu

The user menu (accessible from the header area) provides:

- Display of the authenticated user's `displayName`
- "Darstellung" — a 3-way theme selector with options "Hell" (light), "Dunkel" (dark), "Systemstandard" (system). Selecting an option applies immediately and persists server-side (see [behavior.md §9.6](behavior.md#96-theme-handling)).
- "Passwort ändern" — opens a password change form (current password, new password, confirmation)
- "Abmelden" — logs out and returns to the login screen

---

_Cross-references: [index.md](../index.md) for workflow states and assumptions, [data-model.md](../data-model.md) for entity definitions, [api.md](../api.md) for API operations, [verification.md](../verification.md) for acceptance criteria._
