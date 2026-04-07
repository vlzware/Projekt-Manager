# Architecture

Onboarding document. Read this first, then navigate to the module you need.

For the full product specification, see [docs/spec/](docs/spec/index.md).

---

## Tech Stack

| Technology | Version | Purpose | Docs |
|---|---|---|---|
| TypeScript | 6.0 | Language (strict, shared client+server) | [typescriptlang.org](https://www.typescriptlang.org/) |
| React | 19 | UI rendering | [react.dev](https://react.dev/) |
| Vite | 8 | Dev server, bundler, HMR | [vite.dev](https://vite.dev/) |
| Zustand | 5 | Client-side state management | [zustand](https://github.com/pmndrs/zustand) |
| Fastify | 5 | HTTP server and API framework | [fastify.dev](https://fastify.dev/) |
| Drizzle ORM | 0.45 | Type-safe SQL, schema, migrations | [orm.drizzle.team](https://orm.drizzle.team/) |
| PostgreSQL | 17 | Relational database | [postgresql.org](https://www.postgresql.org/) |
| MinIO | S3-compatible | Object/file storage (future uploads) | [min.io](https://min.io/) |
| Caddy | 2 | Reverse proxy, automatic HTTPS | [caddyserver.com](https://caddyserver.com/) |
| Vitest | 4 | Unit and component tests | [vitest.dev](https://vitest.dev/) |
| Playwright | 1.59 | End-to-end tests | [playwright.dev](https://playwright.dev/) |

Stack decisions are recorded in ADRs: [ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md) (frontend), [ADR-0003](docs/adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) (infra), [ADR-0004](docs/adr/0004-backend-stack-fastify-drizzle-node-postgres.md) (backend).

---

## Architecture Overview

Six responsibility layers. Dependency flows left-to-right only, never reversed. See [spec 11.2](docs/spec/architecture.md) for the full contract.

```
  config  <--  domain  <--  storage  <--  api
                        <--  state   <--  ui

  src/config/          src/domain/       src/server/config/         src/server/routes/
                                         src/server/db/             src/server/middleware/
                                         src/server/repositories/
                                         src/server/services/
                                         src/server/storage/        src/state/
                                                                    src/ui/
```

- **Config** and **Domain** are shared: both server and client import them.
- **Storage**, **API** run server-side only.
- **State**, **UI** run client-side only.

---

## Module Map

| Directory | Owns | Must NOT |
|---|---|---|
| `src/config/` | State definitions, colors, thresholds, branding, company assumptions | Import anything outside `src/config/` |
| `src/domain/` | Types, transition rules, aging calc, validation, date formatting | Import from state, API, storage, or UI |
| `src/server/config/` | Env validation (Zod), centralized policy constants (auth, rate limits, storage) | Contain business logic or import from layers above |
| `src/server/db/` | Drizzle schema, connection, SQL migrations | Contain business logic |
| `src/server/services/` | Business logic orchestration (AuthService, ProjectService) | Know about HTTP, Fastify, or request objects |
| `src/server/repositories/` | Database queries (project, user, session) | Know about HTTP or contain business rules |
| `src/server/storage/` | S3/MinIO client, upload/download/presign ops | Be called from anywhere except API routes |
| `src/server/middleware/` | Cookie parsing, session auth, request decoration | Contain route handlers or business logic |
| `src/server/routes/` | Route definitions, request validation, response serialization | Access repositories directly (must go through services) |
| `src/server/` (root files) | App assembly (`app.ts`), entry point (`start.ts`), seed, password hashing, error types | - |
| `src/state/` | Zustand stores (authStore, projectStore, uiStore), client-side cache | Access the database or import server code |
| `src/api/` | Centralized API client, typed fetch wrappers | Contain business logic or UI concerns |
| `src/hooks/` | Shared React hooks (transitions, routing) | Contain API calls directly (must use stores) |
| `src/ui/` | React components (kanban, calendar, detail, auth, layout) | Contain business logic beyond dispatching to state |
| `src/data/` | Legacy mock data (iteration 1 artifact) | Be imported in production code |
| `src/test/` | Shared test setup and API test helpers | Be imported in production code |

---

## Request Lifecycle

A typical authenticated API call, end to end:

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

| Method | Path | Auth | Permission | Rate limit | Purpose |
|---|---|---|---|---|---|
| GET | `/api/health` | none | — | none | Liveness probe; does not touch the database |
| POST | `/api/auth/login` | none | — | 5 / 1 min | Login; sets HttpOnly `session` cookie |
| POST | `/api/auth/logout` | session | — | none | Invalidates the current session |
| GET | `/api/auth/me` | session | — | none | Current user profile |
| POST | `/api/auth/change-password` | session | — | 5 / 1 min | Change own password (requires current password) |
| GET | `/api/projects` | session | — | none | List projects (optional `offset`, `limit`) |
| GET | `/api/projects/:id` | session | — | none | Single project |
| POST | `/api/projects/:id/transition/forward` | session | `project:transition` | none | Advance status by one step |
| POST | `/api/projects/:id/transition/backward` | session | `project:transition` | none | Reverse status by one step |
| PATCH | `/api/projects/:id/dates` | session | `project:dates` | none | Update `plannedStart` / `plannedEnd` |
| POST | `/api/projects/bulk/import` | session | `project:create` | none | Import an array of projects |

Requests to session-protected endpoints without a valid session return `401 UNAUTHENTICATED` (`"Nicht angemeldet."`). Authenticated requests lacking the required permission return `403 NOT_PERMITTED` (`"Keine Berechtigung."`). Both are enforced centrally in `src/server/middleware/auth.ts` — never at the route level.

Route definitions live in `src/server/routes/auth.ts`, `src/server/routes/projects.ts`, and `src/server/routes/projects-bulk.ts`. The health endpoint is registered in `src/server/start.ts`.

**Keep this table in sync** when adding or changing endpoints. It is the onboarding reference and is cross-checked by the spec (`docs/spec/api.md`) for abstract-operation coverage.

---

## How to Extend

The four scenarios below are the most common changes. Each lists exact files to read first (the existing pattern) and the files to add or edit. The dependency direction in [Architecture Overview](#architecture-overview) is the only invariant — everything else is convention.

### Adding a new entity (e.g., Supplier)

**Pattern to copy**: the `Project` entity. Read `src/server/db/schema.ts:60-99` (table), `src/domain/types.ts:1-33` (interface), `src/server/repositories/project-read.ts` (repo with `toProject` projection), `src/server/repositories/project.ts` (barrel re-export), `src/server/services/ProjectService.ts:49-95` (thin orchestration), `src/server/routes/projects.ts` (routes), `src/state/projectStore.ts` (store).

1. **Schema**: add the table in `src/server/db/schema.ts`. Use the same audit-field pattern as `projects` (`createdAt`/`updatedAt`/`createdBy`/`updatedBy`). Generate the migration with `npx drizzle-kit generate`. Never edit an existing migration file — always generate a new one.
2. **Domain types**: add the TypeScript interface in `src/domain/types.ts`. Keep optional fields optional so the UI tolerates missing data ([spec §13.5](docs/spec/architecture.md#135-robustness)).
3. **Repository**: create `src/server/repositories/supplier-read.ts`, `…-write.ts`, etc. — split by concern as the project repos do. Re-export through a barrel `supplier.ts`. Add a `toSupplier(row)` projection so Drizzle types do not leak upward.
4. **Service**: create `src/server/services/SupplierService.ts`. Keep it framework-agnostic — the service layer must not import `fastify` types ([spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries)).
5. **Routes**: create `src/server/routes/suppliers.ts`. Register it in `src/server/app.ts` next to the existing `projectRoutes(db)` registration. Always go through the service — never call repositories from a route handler.
6. **API client**: add a `supplierApi` block in `src/api/client.ts` (same pattern as `projectApi` at lines 128-144). One typed function per operation, ~3 lines each.
7. **State**: add `src/state/supplierStore.ts` modeled on `src/state/projectStore.ts`. Use optimistic updates with rollback for mutations.
8. **UI**: add components under `src/ui/suppliers/`. One component per file with a sibling `.module.css` (per [CONTRIBUTING.md](CONTRIBUTING.md#code-style)).
9. **Tests**: unit tests in `src/domain/__tests__/` for any pure functions, integration tests in `src/server/__tests__/` (copy `projects-list.test.ts` as a starting point), component tests in `src/ui/__tests__/`.
10. **Seed data**: extend `src/server/seed.ts` if the entity needs demo records.
11. **Spec**: update `docs/spec/data-model.md` (add the entity), `docs/spec/api.md §14.2` (add the operations), and `docs/spec/verification.md` (add ACs).

### Adding a new view (e.g., Worker view)

**Pattern to copy**: the existing Kanban view consumes `useProjectStore` independently of the Calendar view. Read `src/ui/kanban/KanbanBoard.tsx` (the view component), `src/state/projectStore.ts:229-235` (the `getProjectsByState` selector), `src/App.tsx:71-76` (route registration), `src/domain/types.ts:45` (the `ViewMode` union).

1. **View type**: add the new view name to the `ViewMode` union in `src/domain/types.ts:45` (e.g., `'worker' | 'bookkeeper'`).
2. **Component**: create `src/ui/worker/WorkerView.tsx` with its own `WorkerView.module.css`. The component reads from `useProjectStore` and filters in JSX — for example, `projects.filter(p => p.assignedWorkers?.includes(user.displayName))`.
3. **Route**: register in `src/App.tsx` next to the existing kanban/calendar routes.
4. **Navigation**: extend the header dropdown or sidebar so users can switch to the new view.
5. **Tests**: copy the structure from `src/ui/__tests__/KanbanBoard.test.tsx`.

**Backend changes are usually not needed.** The store already exposes the full project list, and any filter that can be expressed against it is a frontend concern. If the view introduces a new query the store cannot answer, add the query to `projectStore.ts` rather than to a new store — that keeps the cache coherent.

### Adding a new API endpoint

**Pattern to copy**: read `src/server/routes/projects.ts` (route definitions), `src/server/services/ProjectService.ts` (service orchestration), and `docs/spec/api.md §14.2` (how operations are documented).

1. **Decide where the route lives**: extend an existing file (`projects.ts`, `auth.ts`, `projects-bulk.ts`) if it belongs to an existing entity/group; create a new route file otherwise.
2. **Define the schema**: every route uses Fastify's JSON Schema for the request body (see `projects.ts` for examples). This is your input validation — don't validate inside the handler.
3. **Auth & permission**: apply `createAuthMiddleware(db)` as a `preHandler` for the plugin, and `requirePermission('your:permission')` per route. Add the new permission key to `src/server/config/permissions.ts` if it doesn't exist.
4. **Delegate to a service method**. Routes never call repositories directly — see [spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries). If the service method doesn't exist yet, add it to the appropriate `*Service.ts`.
5. **Errors**: throw `notFound(...)`, `validationError(...)`, etc. from `src/server/errors.ts`. Never throw raw `Error` from a route — the global handler in `src/server/app.ts:35-42` only normalizes `AppError`.
6. **Register**: add the route plugin in `src/server/app.ts`.
7. **Tests**: integration test in `src/server/__tests__/` using `api-helpers.ts` (`startApp()`, `login()`, `authPost()`/`authGet()`).
8. **Spec**: add the operation to `docs/spec/api.md §14.2` and an AC in `docs/spec/verification.md`.

### Adding a new workflow state

1. Update the state array in `src/config/stateConfig.ts` (name, type, color, aging thresholds, collapse tier).
2. No application code changes are required — the Kanban board, transition logic (`src/domain/transitions.ts`), and aging calculation (`src/domain/aging.ts`) all read from the config.
3. Note that **two existing tests hardcode the state list** and will need updating: `src/server/__tests__/projects-list.test.ts:74-91` and `src/domain/__tests__/transitions.test.ts`.
4. Re-seed the database if existing data must be migrated to a new state (`SEED=force npm run dev`).

---

## Infrastructure

### Docker Compose (production)

Five services defined in `docker-compose.yml`:

| Service | Image / Build | Role |
|---|---|---|
| `app` | `Dockerfile` (multi-stage Node 22 Alpine) | Fastify server serving API + static frontend |
| `db` | `postgres:17-alpine` | PostgreSQL with persistent volume |
| `storage` | `minio/minio` | S3-compatible object storage |
| `storage-init` | `minio/mc` (one-shot) | Creates the default bucket on first start, then exits |
| `caddy` | `caddy:2-alpine` | Reverse proxy, automatic HTTPS via `Caddyfile` |

Local development uses `docker-compose.dev.yml` for database and storage only; app runs via `npm run dev` (Vite + tsx watch).

### CI/CD Pipeline

Two GitHub Actions workflows:

**CI** (`.github/workflows/ci.yml`) -- runs on push/PR to `main` and `iteration/**`:
```
npm audit -> lint -> format check -> type check -> test:coverage -> build
```

**Deploy** (`.github/workflows/deploy.yml`) -- triggers after CI succeeds on `main`:
```
SSH to VPS -> git pull -> docker compose build -> docker compose up -d
```

---

## Links

| Resource | Location |
|---|---|
| Product specification | [docs/spec/](docs/spec/index.md) |
| Architecture Decision Records | [docs/adr/](docs/adr/index.md) |
| Contributing guide and workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Vision and kickoff | [docs/project/kickoff.md](docs/project/kickoff.md) |
| Project journal | [docs/project/journal.md](docs/project/journal.md) |
