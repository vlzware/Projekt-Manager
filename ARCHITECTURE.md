# Architecture

Onboarding document. Read this first, then navigate to the module you need.

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

**Enforcement**: the layer rules are machine-enforced by `no-restricted-imports` zones in [`eslint.config.js`](eslint.config.js) (added in iteration 5). A PR that reaches from `src/ui/**` into `src/server/**`, from `src/server/routes/**` into `src/server/repositories/**`, or from `src/domain/**` into any higher layer fails lint. Type-only imports of `Database` from `src/server/db/connection` are allowed in route files because routes take the connection as a typed parameter.

---

## Module Map

| Directory                  | Owns                                                                                                                                                                                                                                                                                                                           | Must NOT                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `src/config/`              | State definitions, colors, thresholds, branding, company assumptions, insecure-connection detection                                                                                                                                                                                                                            | Import anything outside `src/config/`                   |
| `src/domain/`              | Types, transition rules, aging calc, summary computation, session expiry, date formatting                                                                                                                                                                                                                                      | Import from state, API, storage, or UI                  |
| `src/server/config/`       | Env validation (Zod), centralized policy constants (auth, rate limits, storage)                                                                                                                                                                                                                                                | Contain business logic or import from layers above      |
| `src/server/db/`           | Drizzle schema, connection, SQL migrations                                                                                                                                                                                                                                                                                     | Contain business logic                                  |
| `src/server/services/`     | Business logic orchestration (AuthService, ProjectService), domain event bus (`events.ts` — emits `project.transitioned`, `project.dates_changed`; subscribers attach here for audit, notifications), logger interface                                                                                                         | Know about HTTP, Fastify, or request objects            |
| `src/server/repositories/` | Database queries (project, user, session)                                                                                                                                                                                                                                                                                      | Know about HTTP or contain business rules               |
| `src/server/storage/`      | S3/MinIO client, upload/download/presign ops                                                                                                                                                                                                                                                                                   | Be called from anywhere except API routes               |
| `src/server/middleware/`   | Cookie parsing, session auth, request decoration                                                                                                                                                                                                                                                                               | Contain route handlers or business logic                |
| `src/server/routes/`       | Route definitions, request validation, response serialization                                                                                                                                                                                                                                                                  | Access repositories directly (must go through services) |
| `src/server/data/`         | Static data files (e.g. common-passwords list)                                                                                                                                                                                                                                                                                 | Contain logic or import from other modules              |
| `src/server/` (root files) | App assembly (`app.ts`), entry point (`start.ts`), bootstrap, health probe, seed, password hashing (`hashPassword.ts` — bcrypt; note: bcrypt silently truncates at 72 UTF-8 bytes, so the password policy enforces a hard ceiling there), error types (`errors.ts` — `AppError` subtypes: `notFound`, `validationError`, etc.) | -                                                       |
| `src/state/`               | Zustand stores (authStore, projectStore, uiStore, confirmStore), barrel re-export + cross-store reset (store.ts), client-side cache                                                                                                                                                                                            | Access the database or import server code               |
| `src/api/`                 | Centralized API client, typed fetch wrappers                                                                                                                                                                                                                                                                                   | Contain business logic or UI concerns                   |
| `src/hooks/`               | Shared React hooks (transitions, routing)                                                                                                                                                                                                                                                                                      | Contain API calls directly (must use stores)            |
| `src/ui/`                  | React components (kanban, calendar, detail, auth, layout)                                                                                                                                                                                                                                                                      | Contain business logic beyond dispatching to state      |
| `src/test/`                | Shared test setup, API test helpers, and seed fixtures                                                                                                                                                                                                                                                                         | Be imported in production code                          |

### Configuration Files

Each `[C]` marker in the [spec](docs/spec/index.md) corresponds to a value that can vary per deployment. This table maps them to files.

| What                                                                      | File                                   |
| ------------------------------------------------------------------------- | -------------------------------------- |
| App name, branding, footer text                                           | `src/config/brandingConfig.ts`         |
| Workflow states (labels, colors, order, aging thresholds, collapse tiers) | `src/config/stateConfig.ts`            |
| German UI and error strings                                               | `src/config/strings.ts`                |
| Date and locale display settings                                          | `src/config/localeConfig.ts`           |
| Insecure-connection detection                                             | `src/config/insecureConnection.ts`     |
| Password policy (min length, max bytes, blocklist)                        | `src/server/config/password-policy.ts` |
| Session duration, rate-limit windows                                      | `src/server/config/index.ts`           |
| Role set and per-role permission matrix                                   | `src/server/config/permissions.ts`     |
| Seed default password                                                     | `src/test/seedAssumptions.ts`          |

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

| Method | Path                                    | Auth    | Permission             | Rate limit | Purpose                                                                                                                                                      |
| ------ | --------------------------------------- | ------- | ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/health`                           | none    | —                      | none       | Liveness probe; runs `SELECT 1` on the DB and a `HeadBucket` on MinIO in parallel. Returns `{status,checks:{db,storage}}`; 503 on any probe failure. See #48 |
| POST   | `/api/auth/login`                       | none    | —                      | 5 / 1 min  | Login; sets HttpOnly `session` cookie                                                                                                                        |
| POST   | `/api/auth/logout`                      | session | —                      | none       | Invalidates the current session                                                                                                                              |
| GET    | `/api/auth/me`                          | session | —                      | none       | Current user profile (no permission — the caller is always looking up themselves)                                                                            |
| POST   | `/api/auth/change-password`             | session | `auth:change-password` | 5 / 1 min  | Change own password (requires current password)                                                                                                              |
| GET    | `/api/projects`                         | session | `project:read`         | none       | List projects (optional `offset`, `limit`)                                                                                                                   |
| GET    | `/api/projects/:id`                     | session | `project:read`         | none       | Single project                                                                                                                                               |
| POST   | `/api/projects/:id/transition/forward`  | session | `project:transition`   | none       | Advance status by one step                                                                                                                                   |
| POST   | `/api/projects/:id/transition/backward` | session | `project:transition`   | none       | Reverse status by one step                                                                                                                                   |
| PATCH  | `/api/projects/:id/dates`               | session | `project:dates`        | none       | Update `plannedStart` / `plannedEnd`                                                                                                                         |
| POST   | `/api/projects/bulk/import`             | session | `project:create`       | none       | Import an array of projects (schema cap: 1000 items)                                                                                                         |

Requests to session-protected endpoints without a valid session return `401 UNAUTHENTICATED` (`"Nicht angemeldet."`). Authenticated requests lacking the required permission return `403 NOT_PERMITTED` (`"Keine Berechtigung."`). Authentication is enforced by `createAuthMiddleware(db)` in `src/server/middleware/auth.ts` (applied as a plugin-level `preHandler` hook). **Permission** is enforced at the **route level** by `requirePermission('...')` preHandlers defined in `src/server/routes/*.ts` and checked against the role matrix in `src/server/config/permissions.ts` — see [spec §14.3](docs/spec/api.md#143-authorization-rules).

Route definitions live in `src/server/routes/auth.ts`, `src/server/routes/projects.ts`, and `src/server/routes/projects-bulk.ts`. The health endpoint is registered in `src/server/start.ts`.

**Keep this table in sync** when adding or changing endpoints. It is the onboarding reference and is cross-checked by the spec (`docs/spec/api.md`) for abstract-operation coverage.

---

## How to Extend

The four scenarios below are the most common changes. Each lists exact files to read first (the existing pattern) and the files to add or edit. The dependency direction in [Architecture Overview](#architecture-overview) is the only invariant — everything else is convention.

### Adding a new entity (e.g., Supplier)

**Pattern to copy**: the `Project` entity. Read `src/server/db/schema.ts` (`projects` table definition), `src/domain/types.ts` (`Project` interface), `src/server/repositories/project-read.ts` (repo with `toProject` projection), `src/server/repositories/project.ts` (barrel re-export), `src/server/services/ProjectService.ts` (`ProjectService` class — CRUD, transitions, bulk import), `src/server/routes/projects.ts` (routes), `src/state/projectStore.ts` (store).

1. **Schema**: add the table in `src/server/db/schema.ts`. Use the same audit-field pattern as `projects` (`createdAt`/`updatedAt`/`createdBy`/`updatedBy`). Generate the migration with `npx drizzle-kit generate`. Never edit an existing migration file — always generate a new one.
2. **Domain types**: add the TypeScript interface in `src/domain/types.ts`. Keep optional fields optional so the UI tolerates missing data ([spec §13.5](docs/spec/architecture.md#135-robustness)).
3. **Repository**: create `src/server/repositories/supplier-read.ts`, `supplier-transitions.ts`, etc. — split by concern as the project repos do (`project-read.ts`, `project-transitions.ts`, `project-dates.ts`). Re-export through a barrel `supplier.ts`. Add a `toSupplier(row)` projection so Drizzle types do not leak upward.
4. **Service**: create `src/server/services/SupplierService.ts`. Keep it framework-agnostic — the service layer must not import `fastify` types ([spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries)).
5. **Routes**: create `src/server/routes/suppliers.ts`. Register it in `src/server/app.ts` next to the existing `projectRoutes(db)` registration. Always go through the service — never call repositories from a route handler.
6. **API client**: add a `supplierApi` block in `src/api/client.ts` (same pattern as the `projectApi` export). One typed function per operation, ~3 lines each.
7. **State**: add `src/state/supplierStore.ts` modeled on `src/state/projectStore.ts`. Use optimistic updates with rollback for mutations.
8. **UI**: add components under `src/ui/suppliers/`. One component per file with a sibling `.module.css` (per [CONTRIBUTING.md](CONTRIBUTING.md#code-style)).
9. **Tests**: unit tests in `src/domain/__tests__/` for any pure functions, integration tests in `src/server/__tests__/` (copy `projects-list.test.ts` as a starting point), component tests in `src/ui/__tests__/`.
10. **Seed data**: extend `src/server/seed.ts` if the entity needs demo records.
11. **Spec**: update `docs/spec/data-model.md` (add the entity), `docs/spec/api.md §14.2` (add the operations), and `docs/spec/verification.md` (add ACs).

### Adding a new view (e.g., Worker view)

**Pattern to copy**: the existing Kanban view consumes `useProjectStore` independently of the Calendar view. Read `src/ui/kanban/KanbanBoard.tsx` (the view component), `src/state/projectStore.ts` (`getProjectsByState` selector), `src/App.tsx` (route registration), `src/domain/types.ts` (`ViewMode` union).

1. **View type**: add the new view name to the `ViewMode` union in `src/domain/types.ts` (e.g., `'worker' | 'bookkeeper'`).
2. **Component**: create `src/ui/worker/WorkerView.tsx` with its own `WorkerView.module.css`. The component reads from `useProjectStore` and filters in JSX — for example, `projects.filter(p => p.assignedWorkers?.some(w => w.userId === user.id))`.
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
5. **Errors**: throw `notFound(...)`, `validationError(...)`, etc. from `src/server/errors.ts`. Never throw raw `Error` from a route — the global handler in `src/server/app.ts` normalizes `AppError`, Fastify validation errors, and rate-limit errors; unknown errors are wrapped as a generic server error so internals never leak. For bulk operations, translate database constraint violations to German user-facing messages via the service layer (see `ProjectService.translatePgError()` for the pattern) — no column, table, or constraint name may reach the client.
6. **Register**: add the route plugin in `src/server/app.ts`.
7. **Tests**: integration test in `src/server/__tests__/` using `api-helpers.ts` (`startApp()`, `login()`, `authPost()`/`authGet()`).
8. **Spec**: add the operation to `docs/spec/api.md §14.2` and an AC in `docs/spec/verification.md`.

### Adding a new workflow state

Most of the Kanban, calendar, and aging rendering is genuinely config-driven. Two specific places still hardcode boundary-state literals and will need updating in addition to the config:

1. Update the state array in `src/config/stateConfig.ts` (name, type, color, aging thresholds, collapse tier).
2. **Boundary-state references**: `src/domain/transitions.ts` uses hardcoded `'anfrage'` and `'erledigt'` literals for "first state" and "terminal state" checks. If the new state is inserted in the middle these are safe; if it replaces the first or last position, update the literals to match. The server-side repository path (`src/server/repositories/project-transitions.ts`) is config-driven via `WORKFLOW_ORDER` and does not need changes.
3. **Database default**: `src/server/db/schema.ts` defaults the `status` column to `'anfrage'`. If you change the first state, generate a migration with `npx drizzle-kit generate` to update the default.
4. **Hardcoded test fixtures**: a couple of tests pin the full state list — grep for the state keys and update as needed.
5. Re-seed the database if existing data must be migrated to a new state (`SEED=force npm run dev`).

This is not a zero-code-change operation. Improving it toward full configurability is tracked in [spec §3](docs/spec/index.md#3-workflow-states).

### Seeding modes

The seed loader (`src/server/seed.ts`) is controlled by environment:

- **Production** (`NODE_ENV=production`): seeding is skipped entirely — the start-up path in `src/server/start.ts` never calls it.
- **`SEED=true`** (default in dev): loads seed data if the database is empty; no-ops if data already exists.
- **`SEED=force`**: drops all seed records and reloads from scratch. Use after schema changes or to refresh stale demo dates.

Run via `SEED=force npm run dev` or set in `.env`.

---

## Infrastructure

### Docker Compose (production)

Five services defined in `docker-compose.yml`:

| Service        | Image / Build                                        | Role                                                  |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `app`          | `ghcr.io/vlzware/projekt-manager` (GHCR)             | Fastify server serving API + static frontend          |
| `db`           | `postgres:17-alpine`                                 | PostgreSQL with persistent volume                     |
| `storage`      | `minio/minio`                                        | S3-compatible object storage                          |
| `storage-init` | `minio/mc` (one-shot)                                | Creates the default bucket on first start, then exits |
| `caddy`        | `build: ./docker/caddy` (xcaddy + Cloudflare plugin) | Reverse proxy, HTTPS via DNS-01 ACME                  |

Local development uses `docker-compose.dev.yml` for database and storage only; app runs via `npm run dev` (Vite + tsx watch).

### CI/CD Pipeline

One GitHub Actions workflow (`ci.yml`) produces an image; one operator-run script (`scripts/deploy.sh`) promotes it. There is no separate deploy workflow — the push-based deploy that older revisions of this doc described was removed in iteration 4 per [ADR-0012](docs/adr/0012-manual-pull-based-deploy-over-wireguard.md).

**CI** (`.github/workflows/ci.yml`) — triggered on push and PR to `main` and `iteration/**`. Single `check` job runs, in order:

1. `npm audit` with the suppressed-advisory handling from [ADR-0007](docs/adr/0007-suppress-esbuild-dev-server-advisory.md).
2. `npm run lint`, `npm run format:check`, `npx tsc --noEmit`.
3. `bash scripts/check-env-drift.sh` — regression guard that every `env.ts` variable is forwarded via `docker-compose.yml`'s `services.app.environment`. Added after the incident where `BOOTSTRAP_ADMIN_*` landed in the Zod schema but were forgotten in compose.
4. Postgres service container + MinIO container started as steps; `npm run test:coverage` runs unit + integration against real Postgres and real MinIO. Playwright is **not** part of the push/PR gate — the on-demand workflow `.github/workflows/e2e.yml` (added in iteration 5) runs it on `workflow_dispatch` only, so CI green on push does not imply E2E green. See [docs/spec/architecture.md §11.7](docs/spec/architecture.md#117-ci-gate) and [docs/spec/verification.md AC-37](docs/spec/verification.md#157-non-functional-requirements).
5. `npm run build`.
6. On push events only: `docker/build-push-action` builds the app image and pushes it to GHCR tagged `sha-<commit>` and `<branch-slug>`. PR events do not push.

**Deploy** (`scripts/deploy.sh`) — manual, pull-based, run on the VPS by the operator over WireGuard:

1. Operator is already on the VPS (via WireGuard + sudo); invokes `sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [<ref>]`. Default ref is `origin/main`; pass an explicit SHA for rollback.
2. `git fetch origin`, `git checkout <expected-sha>`, assert `HEAD` landed at the expected SHA (hard-coded guard against a silently failed checkout).
3. Decrypt `/opt/projekt-manager/secrets.env.age` via `age -d`, `source <(...)` with `set -a` so the KEY=VALUE lines reach compose. Plaintext is never written to disk.
4. `APP_IMAGE_TAG=sha-<sha> docker compose pull app` — pulls the pre-built image from GHCR (no build on the VPS, per ADR-0011).
5. `docker compose up -d` — swaps the `app` container to the new image; `db`, `storage`, and `caddy` keep running on their pinned images.
6. Smoke test: `docker compose exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"` polls for up to 60 s. Failure dumps the last 50 lines of compose logs and exits non-zero, leaving the previously running version in place.

No automatic deploy. Rationale: [ADR-0012](docs/adr/0012-manual-pull-based-deploy-over-wireguard.md). Day-to-day procedure: [docs/ops/manual-deploy.md](docs/ops/manual-deploy.md). Bootstrap (first-run) procedure: [docs/ops/manual-deploy.md#bootstrap-first-run-on-fresh-vps](docs/ops/manual-deploy.md#bootstrap-first-run-on-fresh-vps).

---

## Links

| Resource                        | Location                                           |
| ------------------------------- | -------------------------------------------------- |
| Product specification           | [docs/spec/](docs/spec/index.md)                   |
| Architecture Decision Records   | [docs/adr/](docs/adr/index.md)                     |
| Contributing guide and workflow | [CONTRIBUTING.md](CONTRIBUTING.md)                 |
| Vision and kickoff              | [docs/project/kickoff.md](docs/project/kickoff.md) |
| Project journal                 | [docs/project/journal.md](docs/project/journal.md) |
