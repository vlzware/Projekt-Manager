# Architecture

Navigation guide to the implementation. Use it to locate modules, understand dependency rules, and find the right file before diving into code. Not a substitute for reading the code itself.

For the full product specification, see [docs/spec/](docs/spec/index.md).

---

## Tech Stack

| Technology  | Version       | Purpose                                 | Docs                                                  |
| ----------- | ------------- | --------------------------------------- | ----------------------------------------------------- |
| TypeScript  | 6.0           | Language (strict, shared client+server) | [typescriptlang.org](https://www.typescriptlang.org/) |
| React       | 19            | UI rendering                            | [react.dev](https://react.dev/)                       |
| Vite        | 8             | Dev server, bundler, HMR                | [vite.dev](https://vite.dev/)                         |
| Zustand     | 5             | Client-side state management            | [zustand](https://github.com/pmndrs/zustand)          |
| Fastify     | 5             | HTTP server and API framework           | [fastify.dev](https://fastify.dev/)                   |
| Drizzle ORM | 0.45          | Type-safe SQL, schema, migrations       | [orm.drizzle.team](https://orm.drizzle.team/)         |
| PostgreSQL  | 17            | Relational database                     | [postgresql.org](https://www.postgresql.org/)         |
| MinIO       | S3-compatible | Object/file storage (future uploads)    | [min.io](https://min.io/)                             |
| Caddy       | 2             | Reverse proxy, automatic HTTPS          | [caddyserver.com](https://caddyserver.com/)           |
| Vitest      | 4             | Unit and component tests                | [vitest.dev](https://vitest.dev/)                     |
| Playwright  | 1.59          | End-to-end tests                        | [playwright.dev](https://playwright.dev/)             |

Stack decisions are recorded in ADRs: [ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md) (frontend), [ADR-0003](docs/adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) (infra), [ADR-0004](docs/adr/0004-backend-stack-fastify-drizzle-node-postgres.md) (backend).

---

## Architecture Overview

Seven responsibility layers. Dependency flows left-to-right only, never reversed. The split on the server between **Services** and **Routes** is load-bearing — routes never touch repositories or db/schema directly; they delegate to services. See [spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries) for the authoritative contract.

```
  config  <--  domain  <--  storage  <--  services  <--  routes
                        <--  state   <--  ui

  src/config/         src/domain/    src/server/repositories/   src/server/services/   src/server/routes/
                                     src/server/storage/                               src/server/middleware/
                                                                                       src/state/
                                                                                       src/ui/
```

- **Config** and **Domain** are shared: both server and client import them.
- **Storage**, **Services**, **Routes** run server-side only.
- **State**, **UI** run client-side only.

**Enforcement**: the layer rules are machine-enforced by `no-restricted-imports` zones in [`eslint.config.js`](eslint.config.js). A PR that reaches from `src/ui/**` into `src/server/**`, from `src/server/routes/**` into `src/server/repositories/**`, or from `src/domain/**` into any higher layer fails lint. Type-only imports of `Database` from `src/server/db/connection` are allowed in route files because routes take the connection as a typed parameter.

---

## Module Map

| Directory                  | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Must NOT                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `src/config/`              | State definitions, colors, thresholds, branding, company assumptions, insecure-connection detection, central route/nav table (`routes.ts`), backup-freshness thresholds (`backupThresholds.ts`), destructive-restore confirmation phrase (`dataExchangeConfig.ts`), theme-preference storage key (`themeStorage.ts`), audit retention window (`auditRetention.ts` — ADR-0021), audit action→German label map (`auditActionLabels.ts`), audit list page size (`auditPageSize.ts`)                                                                                                                                                                                                                                                                               | Import anything outside `src/config/`                   |
| `src/domain/`              | Types, transition rules, aging calc, summary computation, session expiry, date formatting, unified data-exchange envelope contract (`dataExchange.ts`, ADR-0018), backup-badge state derivation (`backupBadge.ts`), name normalization (`nameNormalize.ts`), audit-payload type guards + action-to-German one-liner derivation (`audit.ts`, `auditRowDescription.ts`)                                                                                                                                                                                                                                                                                                                                                                                          | Import from state, API, storage, or UI                  |
| `src/server/config/`       | Env validation (Zod), centralized policy constants (auth, rate limits, storage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Contain business logic or import from layers above      |
| `src/server/db/`           | Drizzle schema, connection, SQL migrations, named constraints (`constraints.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Contain business logic                                  |
| `src/server/services/`     | Business logic orchestration (`AuthService.ts`, `AuditService.ts`, `CustomerService.ts`, `ExportService.ts`, `ImportService.ts`, `ExtractionService.ts`, project split by concern (`ProjectCrudService.ts`, `ProjectTransitionService.ts`, `ProjectDatesService.ts`, barrel `project.ts`), `UserService.ts`, `BackupStatusService.ts`), single-write-path audit helper (`mutate.ts` — ADR-0021), post-commit audit publisher (`audit-publisher.ts` — AC-183), audit retention cleanup (`audit-retention.ts` — AC-184), Layer 2 backup pipeline (`backup.ts`, `backup-drill.ts`, `ephemeralPg.ts`, `r2Uploader.ts` — ADR-0020), idempotent create orchestrator (`idempotency.ts`), domain event bus (`events.ts`), service-layer logger interface (`Logger.ts`) | Know about HTTP, Fastify, or request objects            |
| `src/server/repositories/` | Database queries: project split by concern (`project-read.ts`, `project-transitions.ts`, `project-dates.ts`, barrel `project.ts`), `customer.ts`, `user.ts`, `session.ts`, single-row backup-status (`backupStatus.ts`), audit-log read surface (`audit.ts` — ADR-0021), role-based read-scope predicates including the two audit predicates (`scope.ts` — ADR-0019). Write functions on audited tables accept `MutatingDatabase` (a transaction-only handle — see `src/server/db/connection.ts`) so a caller bypassing `mutate()` fails `tsc`.                                                                                                                                                                                                                | Know about HTTP or contain business rules               |
| `src/server/storage/`      | S3/MinIO client + upload/download/delete/presign ops (`client.ts`), barrel re-export (`index.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Be called outside routes and `start.ts` (health probe)  |
| `src/server/middleware/`   | Cookie parsing, session auth, request decoration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Contain route handlers or business logic                |
| `src/server/routes/`       | Route definitions, request validation, response serialization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Access repositories directly (must go through services) |
| `src/server/seed/`         | Seed data split per data class: users via direct DB (`users.ts`), customers/projects/assignments via `ImportService` (`business.ts`) so every seed run exercises the public restore contract, shared date helper (`daysFromNow.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Contain app logic; run in production                    |
| `src/server/data/`         | Static data files (e.g. common-passwords list)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Contain logic or import from other modules              |
| `src/server/` (root files) | App assembly (`app.ts`), entry point (`start.ts`), first-run admin bootstrap (`bootstrap.ts`), health probe (`health.ts`), seed orchestrator (`seed.ts` — delegates to `src/server/seed/`), password hashing (`password.ts` — thin `bcryptjs` wrapper; bcrypt's silent 72-UTF-8-byte truncation is fenced off by the ceiling in `src/server/config/password-policy.ts`), periodic session reaper (`session-reaper.ts`), audit retention scheduler (`audit-retention-scheduler.ts` — ADR-0021), Layer 2 backup CLI entry (`backup-runner.ts` — `run`/`drill` subcommands, executed by the `backup` container per ADR-0020), error factories (`errors.ts` — `notFound()`, `validationError()`, etc. return `AppError` instances)                                 | -                                                       |
| `src/state/`               | Zustand stores (`authStore`, `auditStore`, `confirmStore`, `customerStore`, `dataExchangeStore`, `extractionActions`, `projectManagementStore`, `projectStore`, `sessionExpired`, `uiStore`, `userStore`), barrel re-export (`store.ts`), client-side cache                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Access the database or import server code               |
| `src/api/`                 | Centralized API client, typed fetch wrappers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Contain business logic or UI concerns                   |
| `src/hooks/`               | Shared React hooks (transitions, routing, permission gating)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Contain API calls directly (must use stores)            |
| `src/ui/`                  | React components (`audit`, `auth`, `calendar`, `common`, `detail`, `extraction`, `kanban`, `layout`, `management`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Contain business logic beyond dispatching to state      |
| `src/test/`                | Shared test setup, API test helpers, and seed fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Be imported in production code                          |

### Configuration Files

Maps spec `[C]` markers (values that vary per deployment) to files.

| What                                                                      | File                                   |
| ------------------------------------------------------------------------- | -------------------------------------- |
| App name, branding, footer text, brand accent (light + dark)              | `src/config/brandingConfig.ts`         |
| Color design tokens — primitive palette, semantic tokens, dark overrides  | `src/styles/tokens.css`                |
| Workflow states (labels, colors, order, aging thresholds, collapse tiers) | `src/config/stateConfig.ts`            |
| German UI and error strings                                               | `src/config/strings.ts`                |
| Date and locale display settings                                          | `src/config/localeConfig.ts`           |
| Insecure-connection detection                                             | `src/config/insecureConnection.ts`     |
| Password policy (min length, max bytes, blocklist)                        | `src/server/config/password-policy.ts` |
| Session duration, rate-limit windows                                      | `src/server/config/index.ts`           |
| Role set and per-role permission matrix                                   | `src/config/permissions.ts`            |
| Per-view nav + route-guard rules (URL ↔ view ↔ access predicate)          | `src/config/routes.ts`                 |
| Backup-freshness thresholds (amber/red days for backup and drill)         | `src/config/backupThresholds.ts`       |
| Destructive-restore confirmation phrase                                   | `src/config/dataExchangeConfig.ts`     |
| Theme preference local-storage key                                        | `src/config/themeStorage.ts`           |
| Audit retention window                                                    | `src/config/auditRetention.ts`         |
| Audit action → German label map                                           | `src/config/auditActionLabels.ts`      |
| Audit list page size                                                      | `src/config/auditPageSize.ts`          |
| Seed default password                                                     | `src/test/seedAssumptions.ts`          |

---

## Request Lifecycle

```
Browser (React)
  |  user action triggers Zustand store method
  v
Zustand store
  |  fetch("/api/projects/42/transition", { method: "POST", ... })
  v
Vite dev proxy  (dev: localhost:5173 -> :3000)
Caddy           (prod: HTTPS termination, reverse_proxy -> app:3000)
  v
Fastify
  |  @fastify/cookie parses session cookie
  |  auth middleware validates session via session repository
  |  -> 401 if missing/expired
  v
Route handler (src/server/routes/)
  |  validates request body (Fastify JSON schema)
  |  delegates to service
  v
Service (src/server/services/)
  |  business logic, domain validation
  |  calls repository for data access
  v
Repository (src/server/repositories/) -> Drizzle ORM -> PostgreSQL
  |  query executes, returns rows
  v
Route handler
  |  serializes response as JSON
  v
Fastify -> Caddy/proxy -> Browser
  v
Zustand store
  |  updates local state on success
  v
React re-renders affected components
```

---

## API Surface

All HTTP endpoints exposed by the Fastify server. Concrete URL structure lives here because [`docs/spec/api.md`](docs/spec/api.md) is intentionally stack-agnostic (operations, inputs, outputs — not URLs).

| Method | Path                                    | Auth    | Permission             | Rate limit | Purpose                                                                                                                                                                                                                                                         |
| ------ | --------------------------------------- | ------- | ---------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                           | none    | —                      | none       | Liveness probe; runs `SELECT 1` on the DB and a `HeadBucket` on MinIO in parallel. Returns `{status,checks:{db,storage}}`; 503 on any probe failure. See #48                                                                                                    |
| GET    | `/api/backup/status`                    | none    | —                      | 30 / 1 min | Public read of the single-row backup-freshness surface for the owner-only login-screen badge (ADR-0020, AC-176). Body carries only data-model §5.9 fields; `{available:false}` when DB unreachable.                                                             |
| POST   | `/api/auth/login`                       | none    | —                      | 5 / 1 min  | Login; sets HttpOnly `session` cookie                                                                                                                                                                                                                           |
| POST   | `/api/auth/logout`                      | session | —                      | none       | Invalidates the current session                                                                                                                                                                                                                                 |
| GET    | `/api/auth/me`                          | session | —                      | none       | Current user profile. For role `owner`, the response additionally carries `backupStatus` (AC-170 — authenticated-surface badge).                                                                                                                                |
| PATCH  | `/api/auth/me`                          | session | —                      | none       | Update own preferences (theme preference). Self-scope only — cannot affect another user.                                                                                                                                                                        |
| POST   | `/api/auth/change-password`             | session | `auth:change-password` | 5 / 1 min  | Change own password (requires current password)                                                                                                                                                                                                                 |
| GET    | `/api/projects`                         | session | `project:read`         | none       | List projects (optional `offset`, `limit`). Rows are further narrowed by the caller's read scope (ADR-0019).                                                                                                                                                    |
| GET    | `/api/projects/:id`                     | session | `project:read`         | none       | Single project. Out-of-scope rows (ADR-0019) return `403 NOT_PERMITTED`.                                                                                                                                                                                        |
| POST   | `/api/projects`                         | session | `project:create`       | none       | Create project (supports client-supplied id for idempotent retry; see `idempotency.ts`).                                                                                                                                                                        |
| PATCH  | `/api/projects/:id`                     | session | `project:update`       | none       | Update project fields (title, customer, workers, estimated value, notes)                                                                                                                                                                                        |
| DELETE | `/api/projects/:id`                     | session | `project:delete`       | none       | Soft-delete project (sets `deleted=true`; ADR-0017 — "archive")                                                                                                                                                                                                 |
| DELETE | `/api/projects/:id/purge`               | session | `project:purge`        | none       | Hard-delete an already soft-deleted project (owner-only per permission matrix; ADR-0017)                                                                                                                                                                        |
| POST   | `/api/projects/:id/transition/forward`  | session | `project:transition`   | none       | Advance status by one step (requires `expectedStatus` for deterministic AC-94)                                                                                                                                                                                  |
| POST   | `/api/projects/:id/transition/backward` | session | `project:transition`   | none       | Reverse status by one step (requires `expectedStatus` for deterministic AC-94)                                                                                                                                                                                  |
| PATCH  | `/api/projects/:id/dates`               | session | `project:dates`        | none       | Update `plannedStart` / `plannedEnd`                                                                                                                                                                                                                            |
| GET    | `/api/customers`                        | session | `customer:read`        | none       | List customers (optional `search`, `offset`, `limit`). Rows are further narrowed by the caller's read scope (ADR-0019).                                                                                                                                         |
| GET    | `/api/customers/:id`                    | session | `customer:read`        | none       | Single customer with associated project count. Out-of-scope rows return `403`.                                                                                                                                                                                  |
| POST   | `/api/customers`                        | session | `customer:write`       | none       | Create customer (supports client-supplied id for idempotent retry)                                                                                                                                                                                              |
| PATCH  | `/api/customers/:id`                    | session | `customer:write`       | none       | Update customer (PATCH semantics)                                                                                                                                                                                                                               |
| DELETE | `/api/customers/:id`                    | session | `customer:delete`      | none       | Hard-delete customer; rejected if any active project references it (application-level check). Soft-deleted projects are purged atomically in the same tx.                                                                                                       |
| GET    | `/api/users`                            | session | `user:read`            | none       | List users                                                                                                                                                                                                                                                      |
| GET    | `/api/users/:id`                        | session | `user:read`            | none       | Single user                                                                                                                                                                                                                                                     |
| PATCH  | `/api/users/:id`                        | session | `user:manage`          | none       | Update user (roles, active, displayName, email)                                                                                                                                                                                                                 |
| POST   | `/api/users`                            | session | `user:manage`          | none       | Create user                                                                                                                                                                                                                                                     |
| DELETE | `/api/users/:id`                        | session | `user:delete`          | none       | Hard-delete user (owner only)                                                                                                                                                                                                                                   |
| POST   | `/api/users/:id/deactivate`             | session | `user:manage`          | none       | Deactivate user                                                                                                                                                                                                                                                 |
| POST   | `/api/users/:id/reactivate`             | session | `user:manage`          | none       | Reactivate user                                                                                                                                                                                                                                                 |
| POST   | `/api/users/:id/reset-password`         | session | `user:manage`          | none       | Admin password reset                                                                                                                                                                                                                                            |
| GET    | `/api/export`                           | session | `data:export`          | none       | Unified business-data export envelope (ADR-0018). Row-level fidelity including archived rows. Rejected for scoped callers (tripwire for ADR-0019 bypass).                                                                                                       |
| POST   | `/api/import`                           | session | `data:restore`         | none       | Unified restore-only import (ADR-0018). Supports `?dry_run=true` and `?override=true`. Non-empty override additionally requires `confirmation_phrase` in the body (AC-160). Single transaction.                                                                 |
| POST   | `/api/extract`                          | session | `customer:write`       | none       | LLM email extraction via OpenRouter (ADR-0016). Requires `OPENROUTER_API_KEY` env var.                                                                                                                                                                          |
| GET    | `/api/audit`                            | session | `audit:read`           | none       | List audit entries (ADR-0021). Filters: `entityType`, `entityId`, `entityLabelQuery`, `actorId`, `from`, `to`, `action`. Destructive-action narrowing via `auditDestructiveScopeForCaller` — owner unfiltered, office hides purge / user-delete / role-updates. |
| GET    | `/api/audit/:id`                        | session | `audit:read`           | none       | Single audit entry. Out-of-scope rows return `403 NOT_PERMITTED` (parity with AC-147).                                                                                                                                                                          |

Requests to session-protected endpoints without a valid session return `401 UNAUTHENTICATED` (`"Nicht angemeldet."`). Authenticated requests lacking the required permission return `403 NOT_PERMITTED` (`"Keine Berechtigung."`). Authentication is enforced by `createAuthMiddleware(db)` in `src/server/middleware/auth.ts` as a plugin-level `preHandler` hook on auth-gated plugins; public endpoints (`/api/health`, `/api/backup/status`, `/api/auth/login`) omit it. **Permission** is enforced at the **route level** by `requirePermission('...')` preHandlers defined in `src/server/middleware/auth.ts` and checked against the role matrix in `src/config/permissions.ts` — see [spec §14.3](docs/spec/api.md#143-authorization-rules).

Route definitions live in `src/server/routes/`. The health endpoint is registered in `src/server/start.ts`.

**Keep this table in sync** when adding or changing endpoints. It is the onboarding reference and is cross-checked by the spec (`docs/spec/api.md`) for abstract-operation coverage.

---

## Permission Gating

The role-to-permission matrix in `src/config/permissions.ts` is the single source of truth for both layers: server routes import `hasPermission` via `requirePermission(...)` (403 on violation), and UI components import it via the `usePermission('<permission>')` hook in `src/hooks/usePermission.ts` (hide the affordance). Client-side gating is UX, not security — the server check is always authoritative. UI code never hardcodes role names; it asks for a permission. See [spec AC-121](docs/spec/verification.md) for the invariant and [§14.3](docs/spec/api.md#143-authorization-rules) for the server contract.

Per-view navigation and the route guard share a second table in `src/config/routes.ts`: one `canAccess` predicate and one `isDefaultFor` (landing) predicate per view, mixing role- and permission-based checks uniformly. The `Header` nav and the `App` route guard both consume this table so the spec's per-role nav matrix ([spec ui/index.md §8.7.1](docs/spec/ui/index.md#871-views)) cannot drift between what the user sees and what the guard allows.

**Data scoping** is orthogonal to permissions ([ADR-0019](docs/adr/0019-worker-data-scoping-repository-layer-predicate.md)). `project:read` and `customer:read` grant the _capability_ to read; `src/server/repositories/scope.ts` narrows the _extent_ (which rows are visible) with a predicate ANDed into repository queries — currently scoping workers to projects they are assigned to. Services that must bypass scope (e.g., `ExportService`) fail-fast when threaded a scoped caller, so a permission-churn regression cannot silently leak every row.

---

## How to Extend

Common changes and where to look. The dependency direction in [Architecture Overview](#architecture-overview) is the only invariant. Conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

### Adding a new entity (e.g., Supplier)

**Pattern to copy**: the `Project` entity — read `schema.ts`, `types.ts`, the repo/service/route/store/UI chain for projects.

1. **Schema**: add table in `src/server/db/schema.ts` (same audit-field pattern as `projects`). `npx drizzle-kit generate`. Never edit an existing migration.
2. **Domain types**: add interface in `src/domain/types.ts`. Optional fields stay optional ([spec §13.5](docs/spec/architecture.md#135-robustness)).
3. **Repository**: split by concern (`supplier-read.ts`, etc.), barrel re-export. Add a `toSupplier(row)` projection so Drizzle types don't leak upward.
4. **Service**: `src/server/services/SupplierService.ts`. Must not import `fastify` types ([spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries)).
5. **Routes**: `src/server/routes/suppliers.ts`, register in `app.ts`. Routes go through the service, never call repos directly.
6. **API client**: add a `supplierApi` block in `src/api/client.ts` (same shape as `projectApi`).
7. **State**: `src/state/supplierStore.ts` (model on `projectStore.ts`, optimistic updates with rollback).
8. **UI**: components under `src/ui/suppliers/`.
9. **Tests**: domain in `src/domain/__tests__/`, integration in `src/server/__tests__/` (copy `projects-list.test.ts`), component in `src/ui/__tests__/`.
10. **Seed**: extend the relevant loader under `src/server/seed/` (`users.ts` for new user records; `business.ts` for customer/project-like entities that should flow through `ImportService`).
11. **Spec**: update `docs/spec/data-model.md`, `docs/spec/api.md §14.2`, `docs/spec/verification.md`.

### Adding a new view (e.g., Worker view)

**Pattern to copy**: `src/ui/kanban/KanbanBoard.tsx`, `src/state/projectStore.ts` (`getProjectsByState`), `src/config/routes.ts` (ROUTES table), `src/domain/types.ts` (`ViewMode` union).

1. Add view name to `ViewMode` in `src/domain/types.ts`.
2. Create component under `src/ui/<view>/`. Reads from `useProjectStore`, filters client-side.
3. Add a `RouteEntry` to `ROUTES` in `src/config/routes.ts` with `canAccess` and `isDefaultFor` predicates (mirrors the spec's per-role nav matrix — [spec ui/index.md §8.7.1](docs/spec/ui/index.md#871-views)). The `Header` nav and the `ProtectedRoute` guard both derive from this entry automatically.
4. Wire the component into the `VIEW_ELEMENTS` lookup in `src/App.tsx` so `<Routes>` knows what to render for the new key.
5. Tests: copy structure from `src/ui/__tests__/KanbanBoard.test.tsx`.

Backend changes are usually not needed — the store exposes the full project list. If the view needs a query the store can't answer, add it to `projectStore.ts` (keeps the cache coherent) rather than a new store.

### Adding a new API endpoint

**Pattern to copy**: `src/server/routes/projects.ts`, `src/server/services/ProjectCrudService.ts`, `docs/spec/api.md §14.2`.

1. **Where**: extend an existing route file if it belongs to that entity/group; create a new one otherwise.
2. **Validation**: Fastify JSON Schema on the route (see `projects.ts`). Don't validate inside the handler.
3. **Auth**: `createAuthMiddleware(db)` as plugin `preHandler`; `requirePermission('...')` per route. Add new keys to `src/config/permissions.ts` (shared with the client-side `usePermission` hook — see [§ Permission Gating](#permission-gating)).
4. **Delegate to service**. Never call repos from a route ([spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries)).
5. **Errors**: use factories from `src/server/errors.ts` (`notFound()`, `validationError()`, etc.). Never throw raw `Error`. For endpoints accepting composite payloads, translate DB constraint violations via the service layer: classify with `extractSqlState()` / `extractPgConstraint()` and disambiguate against the named constraints in `src/server/db/constraints.ts` (see `ProjectCrudService.createProjectWithClientId` for the 23505 pattern).
6. **Register** in `src/server/app.ts`.
7. **Tests**: integration in `src/server/__tests__/` using `api-helpers.ts` (`startApp()`, `login()`, `authPost()`/`authGet()`).
8. **Spec**: add operation to `docs/spec/api.md §14.2`, AC in `docs/spec/verification.md`.

### Adding a new workflow state

Most of the Kanban, calendar, and aging rendering is genuinely config-driven. Two specific places still hardcode boundary-state literals and will need updating in addition to the config:

1. Update the state array in `src/config/stateConfig.ts` (name, type, color, aging thresholds, collapse tier).
2. **Boundary-state references**: `src/domain/transitions.ts` uses hardcoded `'anfrage'` and `'erledigt'` literals for "first state" and "terminal state" checks. If the new state is inserted in the middle these are safe; if it replaces the first or last position, update the literals to match. The server-side repository path (`src/server/repositories/project-transitions.ts`) is config-driven via `WORKFLOW_ORDER` and does not need changes.
3. **Database constraints**: `src/server/db/schema.ts` has (a) a `status` column default of `'anfrage'` and (b) a `projects_valid_status` CHECK constraint that hard-codes all nine state literals. Adding, renaming, or removing a state requires regenerating the migration via `npx drizzle-kit generate`, otherwise inserts for the new state will be rejected at the DB layer.
4. **Hardcoded test fixtures**: a couple of tests pin the full state list — grep for the state keys and update as needed.
5. Re-seed the database if existing data must be migrated to a new state (`SEED=force npm run dev`).

This is not a zero-code-change operation. Improving it toward full configurability is tracked in [spec §3](docs/spec/index.md#3-workflow-states).

### Seeding modes

The seed loader (`src/server/seed.ts`) is controlled by environment:

- **Production** (`NODE_ENV=production`): seeding is skipped entirely — the start-up path in `src/server/start.ts` never calls it.
- **`SEED=false`** (default — see `src/server/config/env.ts` and `docker-compose.yml`): no seeding. Seeds never run without an explicit opt-in.
- **`SEED=true`**: loads seed data if the database is empty; no-ops if data already exists.
- **`SEED=force`**: drops all seed records and reloads from scratch. Use after schema changes or to refresh stale demo dates.

Run via `SEED=true npm run dev` (or `SEED=force` for a hard refresh) or set in `.env`.

---

## Infrastructure

### Docker Compose (production)

Six services defined in `docker-compose.yml`:

| Service        | Image / Build                                        | Role                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`          | `ghcr.io/vlzware/projekt-manager` (GHCR)             | Fastify server serving API + static frontend                                                                                                                                                                                                                                                                                                                                              |
| `db`           | `postgres:17-alpine`                                 | PostgreSQL with persistent volume                                                                                                                                                                                                                                                                                                                                                         |
| `storage`      | `minio/minio`                                        | S3-compatible object storage                                                                                                                                                                                                                                                                                                                                                              |
| `storage-init` | `minio/mc` (one-shot)                                | Creates the default bucket on first start, then exits                                                                                                                                                                                                                                                                                                                                     |
| `backup`       | `ghcr.io/vlzware/projekt-manager-backup` (GHCR)      | Layer 2 encrypted R2 backup + drill service (ADR-0020). dcron-driven, `TZ=Europe/Berlin`: `run-backup.sh` five times weekdays (09/12/15/18/21) + once weekends (12:00), `run-drill.sh` at +2 min offset on each tick. Retention is linear (14-day R2 bucket lock + 90-day lifecycle); no rotation step. Gated behind the `backup` compose profile so local dev does not spin up the loop. |
| `caddy`        | `build: ./docker/caddy` (xcaddy + Cloudflare plugin) | Reverse proxy, HTTPS via DNS-01 ACME                                                                                                                                                                                                                                                                                                                                                      |

The backup image is built by `Dockerfile.backup` and layers `postgresql17` (server + client), `age`, `dcron`, `tzdata`, and helper binaries onto `node:22.20.0-alpine`. Its `FROM ghcr.io/.../projekt-manager:${APP_IMAGE_TAG}` stage pulls the just-built app bundle so the backup service runs the exact same `backup-runner.js` the app process imports — no skew between the web-handler and cron definitions of `runBackup`.

Local development uses `docker-compose.dev.yml` for database and storage only; app runs via `npm run dev` (Vite + tsx watch). HTTP-only evaluation uses the `docker-compose.http.yml` overlay, which swaps the custom Caddy for stock `caddy:2-alpine` on port 80 (ADR-0013).

### CI/CD Pipeline

One GitHub Actions workflow (`ci.yml`) produces an image; one operator-run script (`scripts/deploy.sh`) promotes it. There is no separate deploy workflow ([ADR-0012](docs/adr/0012-manual-pull-based-deploy-over-wireguard.md)).

**CI** (`.github/workflows/ci.yml`) — triggered on push and PR to `main` and `iteration/**`. Four jobs:

- **`check`** (every event) — in this order: `npm audit` (with the suppressed-advisory handling from [ADR-0007](docs/adr/0007-suppress-esbuild-dev-server-advisory.md)), `npm run lint`, `npm run format:check`, `npx tsc --noEmit`, `bash scripts/check-env-drift.sh` (regression guard that every `env.ts` variable is forwarded via `docker-compose.yml`'s `services.app.environment`; added after `BOOTSTRAP_ADMIN_*` landed in the Zod schema but were forgotten in compose), `bash scripts/check-audit-mutations.sh` (static architecture check per AC-179 — fails when a raw `INSERT/UPDATE/DELETE` on an audited table lands outside `mutate()` and outside the reviewed allowlist; the `MutatingDatabase` type gate is the primary guarantee, the scan is belt-and-braces for dynamic-SQL drift), Postgres service container + in-job MinIO container + `npm run test:coverage` against both, then `npm run build`. Playwright is **not** part of the push/PR gate — the on-demand workflow `.github/workflows/e2e.yml` runs it on `workflow_dispatch` only, so CI green on push does not imply E2E green. See [docs/spec/architecture.md §11.7](docs/spec/architecture.md#117-continuous-delivery-pipeline) and [docs/spec/verification.md AC-37](docs/spec/verification.md#157-engineering).
- **`changes`** — `dorny/paths-filter` detects whether container-relevant files changed; gates the `docker` job so most PRs skip the image build.
- **`docker`** (PRs only, when `changes.docker == true`) — validates `docker compose config` against both the prod file and the prod+dev overlay, then builds the app image with layer caching (no push).
- **`build-and-push`** (push events only, gated on `check`) — builds and pushes **both** the app image and the backup image (`Dockerfile.backup`) to GHCR, each tagged `sha-<commit>` and `<branch-slug>`. The backup build is sequential: its `FROM` references the just-pushed app tag. Followed by a runtime smoke test that `compose up`s the stack against a scratch DB and exercises `run-backup.sh` / `load-drill-key` in the `backup` container — catches runtime defects (missing init, setpgid EPERM, listen_addresses quoting, etc.) that "does it compile?" misses. Production images are built in CI, never on the VPS ([ADR-0011](docs/adr/0011-build-images-in-ci-distribute-via-ghcr.md)).

**Deploy** (`scripts/deploy.sh`) — manual, pull-based, run on the VPS by the operator over WireGuard:

1. Operator is already on the VPS (via WireGuard + sudo); invokes `sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [<ref>]`. Default ref is `origin/main`; pass an explicit SHA for rollback.
2. `git fetch origin`, `git checkout <expected-sha>`, assert `HEAD` landed at the expected SHA (hard-coded guard against a silently failed checkout).
3. Decrypt `/opt/projekt-manager/secrets.env.age` via `age -d`, `source <(...)` with `set -a` so the KEY=VALUE lines reach compose. Plaintext is never written to disk.
4. `APP_IMAGE_TAG=sha-<sha> docker compose --profile backup pull app backup` — fetches both app and backup images from GHCR under the shared SHA tag (no build on the VPS, per ADR-0011). `--profile` is required on pull too, or the backup service is filtered out of the active set.
5. `docker compose --profile backup up -d` — swaps the `app` and `backup` containers to the new images; `db`, `storage`, and `caddy` keep running on their pinned images.
6. Smoke test: `docker compose exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"` polls for up to 60 s. Failure dumps the last 50 lines of compose logs and exits non-zero, leaving the previously running version in place.

No automatic deploy. Rationale: [ADR-0012](docs/adr/0012-manual-pull-based-deploy-over-wireguard.md). Day-to-day procedure: [docs/ops/manual-deploy.md](docs/ops/manual-deploy.md). Bootstrap (first-run) procedure: [docs/ops/manual-deploy.md#bootstrap-first-run-on-fresh-vps](docs/ops/manual-deploy.md#bootstrap-first-run-on-fresh-vps).

---

## Design Decisions (Not ADR-Worthy)

- **Export format**: JSON only. Unified envelope shape defined in [docs/spec/data-model.md §5.8](docs/spec/data-model.md#58-export-envelope).
- **Project number format**: configurable `[C]`, enforced only for uniqueness.
- **Customer duplicates on create**: the single-create form offers to edit existing. Unified import preserves IDs and wipes-then-restores (see [ADR-0018](docs/adr/0018-data-persistence-and-recovery-layered-strategy.md)) — no merge semantics.
- **Bulk transitions**: not supported. Users transition individually.

---

## Links

| Resource                        | Location                                           |
| ------------------------------- | -------------------------------------------------- |
| Product specification           | [docs/spec/](docs/spec/index.md)                   |
| Architecture Decision Records   | [docs/adr/](docs/adr/index.md)                     |
| Contributing guide and workflow | [CONTRIBUTING.md](CONTRIBUTING.md)                 |
| Data persistence and recovery   | [DATA.md](DATA.md)                                 |
| Vision and kickoff              | [docs/project/kickoff.md](docs/project/kickoff.md) |
| Project journal                 | [docs/project/journal.md](docs/project/journal.md) |
