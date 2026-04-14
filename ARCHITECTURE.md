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

| Directory                  | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                 | Must NOT                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `src/config/`              | State definitions, colors, thresholds, branding, company assumptions, insecure-connection detection                                                                                                                                                                                                                                                                                                                                  | Import anything outside `src/config/`                   |
| `src/domain/`              | Types, transition rules, aging calc, summary computation, session expiry, date formatting                                                                                                                                                                                                                                                                                                                                            | Import from state, API, storage, or UI                  |
| `src/server/config/`       | Env validation (Zod), centralized policy constants (auth, rate limits, storage)                                                                                                                                                                                                                                                                                                                                                      | Contain business logic or import from layers above      |
| `src/server/db/`           | Drizzle schema, connection, SQL migrations                                                                                                                                                                                                                                                                                                                                                                                           | Contain business logic                                  |
| `src/server/services/`     | Business logic orchestration (`AuthService.ts`, `CustomerService.ts`, `ExportService.ts`, `ExtractionService.ts`, `ProjectService.ts`, `UserService.ts`), domain event bus (`events.ts`), service-layer logger interface (`Logger.ts`)                                                                                                                                                                                               | Know about HTTP, Fastify, or request objects            |
| `src/server/repositories/` | Database queries: project split by concern (`project-read.ts`, `project-transitions.ts`, `project-dates.ts`, barrel `project.ts`), `customer.ts`, `user.ts`, `session.ts`                                                                                                                                                                                                                                                            | Know about HTTP or contain business rules               |
| `src/server/storage/`      | S3/MinIO client + upload/download/delete/presign ops (`client.ts`), barrel re-export (`index.ts`)                                                                                                                                                                                                                                                                                                                                    | Be called outside routes and `start.ts` (health probe)  |
| `src/server/middleware/`   | Cookie parsing, session auth, request decoration                                                                                                                                                                                                                                                                                                                                                                                     | Contain route handlers or business logic                |
| `src/server/routes/`       | Route definitions, request validation, response serialization                                                                                                                                                                                                                                                                                                                                                                        | Access repositories directly (must go through services) |
| `src/server/data/`         | Static data files (e.g. common-passwords list)                                                                                                                                                                                                                                                                                                                                                                                       | Contain logic or import from other modules              |
| `src/server/` (root files) | App assembly (`app.ts`), entry point (`start.ts`), first-run admin bootstrap (`bootstrap.ts`), health probe (`health.ts`), seed loader (`seed.ts`), password hashing (`password.ts` — thin `bcryptjs` wrapper; bcrypt's silent 72-UTF-8-byte truncation is fenced off by the ceiling in `src/server/config/password-policy.ts`), error factories (`errors.ts` — `notFound()`, `validationError()`, etc. return `AppError` instances) | -                                                       |
| `src/state/`               | Zustand stores (`authStore`, `confirmStore`, `customerStore`, `extractionActions`, `importExportStore`, `projectManagementStore`, `projectStore`, `sessionExpired`, `uiStore`, `userStore`), barrel re-export (`store.ts`), client-side cache                                                                                                                                                                                        | Access the database or import server code               |
| `src/api/`                 | Centralized API client, typed fetch wrappers                                                                                                                                                                                                                                                                                                                                                                                         | Contain business logic or UI concerns                   |
| `src/hooks/`               | Shared React hooks (transitions, routing)                                                                                                                                                                                                                                                                                                                                                                                            | Contain API calls directly (must use stores)            |
| `src/ui/`                  | React components (`auth`, `calendar`, `common`, `detail`, `extraction`, `kanban`, `layout`, `management`)                                                                                                                                                                                                                                                                                                                            | Contain business logic beyond dispatching to state      |
| `src/test/`                | Shared test setup, API test helpers, and seed fixtures                                                                                                                                                                                                                                                                                                                                                                               | Be imported in production code                          |

### Configuration Files

Maps spec `[C]` markers (values that vary per deployment) to files.

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
| POST   | `/api/projects`                         | session | `project:create`       | none       | Create project                                                                                                                                               |
| PATCH  | `/api/projects/:id`                     | session | `project:update`       | none       | Update project fields (title, customer, workers, estimated value, notes)                                                                                     |
| DELETE | `/api/projects/:id`                     | session | `project:delete`       | none       | Soft-delete project (sets `deleted=true`)                                                                                                                    |
| POST   | `/api/projects/:id/transition/forward`  | session | `project:transition`   | none       | Advance status by one step                                                                                                                                   |
| POST   | `/api/projects/:id/transition/backward` | session | `project:transition`   | none       | Reverse status by one step                                                                                                                                   |
| PATCH  | `/api/projects/:id/dates`               | session | `project:dates`        | none       | Update `plannedStart` / `plannedEnd`                                                                                                                         |
| POST   | `/api/projects/bulk/import`             | session | `project:create`       | none       | Import an array of projects (schema cap: 1000 items)                                                                                                         |
| GET    | `/api/customers`                        | session | `customer:read`        | none       | List customers (optional `search`, `offset`, `limit`)                                                                                                        |
| GET    | `/api/customers/:id`                    | session | `customer:read`        | none       | Single customer with associated project count                                                                                                                |
| POST   | `/api/customers`                        | session | `customer:write`       | none       | Create customer                                                                                                                                              |
| PATCH  | `/api/customers/:id`                    | session | `customer:write`       | none       | Update customer (PATCH semantics)                                                                                                                            |
| DELETE | `/api/customers/:id`                    | session | `customer:delete`      | none       | Hard-delete customer; rejected if any active project references it (application-level check). Soft-deleted projects are purged atomically in the same tx.    |
| POST   | `/api/customers/bulk/import`            | session | `customer:write`       | none       | Import an array of customers (schema cap: 1000 items)                                                                                                        |
| GET    | `/api/users`                            | session | `user:read`            | none       | List users                                                                                                                                                   |
| GET    | `/api/users/:id`                        | session | `user:read`            | none       | Single user                                                                                                                                                  |
| PATCH  | `/api/users/:id`                        | session | `user:manage`          | none       | Update user (roles, active, displayName, email)                                                                                                              |
| POST   | `/api/users`                            | session | `user:manage`          | none       | Create user                                                                                                                                                  |
| DELETE | `/api/users/:id`                        | session | `user:delete`          | none       | Hard-delete user (owner only)                                                                                                                                |
| POST   | `/api/users/:id/deactivate`             | session | `user:manage`          | none       | Deactivate user                                                                                                                                              |
| POST   | `/api/users/:id/reactivate`             | session | `user:manage`          | none       | Reactivate user                                                                                                                                              |
| POST   | `/api/users/:id/reset-password`         | session | `user:manage`          | none       | Admin password reset                                                                                                                                         |
| GET    | `/api/export/projects`                  | session | `project:read`         | none       | Export non-deleted projects as JSON (filters: status, customerId, date range)                                                                                |
| GET    | `/api/export/customers`                 | session | `customer:read`        | none       | Export all customers as JSON                                                                                                                                 |
| POST   | `/api/extract`                          | session | `customer:write`       | none       | LLM email extraction via OpenRouter (ADR-0016). Requires `OPENROUTER_API_KEY` env var.                                                                       |

Requests to session-protected endpoints without a valid session return `401 UNAUTHENTICATED` (`"Nicht angemeldet."`). Authenticated requests lacking the required permission return `403 NOT_PERMITTED` (`"Keine Berechtigung."`). Authentication is enforced by `createAuthMiddleware(db)` in `src/server/middleware/auth.ts` (applied as a plugin-level `preHandler` hook). **Permission** is enforced at the **route level** by `requirePermission('...')` preHandlers defined in `src/server/middleware/auth.ts` and checked against the role matrix in `src/server/config/permissions.ts` — see [spec §14.3](docs/spec/api.md#143-authorization-rules).

Route definitions live in `src/server/routes/`. The health endpoint is registered in `src/server/start.ts`.

**Keep this table in sync** when adding or changing endpoints. It is the onboarding reference and is cross-checked by the spec (`docs/spec/api.md`) for abstract-operation coverage.

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
10. **Seed**: extend `src/server/seed.ts` if needed.
11. **Spec**: update `docs/spec/data-model.md`, `docs/spec/api.md §14.2`, `docs/spec/verification.md`.

### Adding a new view (e.g., Worker view)

**Pattern to copy**: `src/ui/kanban/KanbanBoard.tsx`, `src/state/projectStore.ts` (`getProjectsByState`), `src/App.tsx` (route registration), `src/domain/types.ts` (`ViewMode` union).

1. Add view name to `ViewMode` in `src/domain/types.ts`.
2. Create component under `src/ui/worker/`. Reads from `useProjectStore`, filters client-side.
3. Register route in `src/App.tsx`.
4. Extend header/sidebar navigation.
5. Tests: copy structure from `src/ui/__tests__/KanbanBoard.test.tsx`.

Backend changes are usually not needed — the store exposes the full project list. If the view needs a query the store can't answer, add it to `projectStore.ts` (keeps the cache coherent) rather than a new store.

### Adding a new API endpoint

**Pattern to copy**: `src/server/routes/projects.ts`, `src/server/services/ProjectService.ts`, `docs/spec/api.md §14.2`.

1. **Where**: extend an existing route file if it belongs to that entity/group; create a new one otherwise.
2. **Validation**: Fastify JSON Schema on the route (see `projects.ts`). Don't validate inside the handler.
3. **Auth**: `createAuthMiddleware(db)` as plugin `preHandler`; `requirePermission('...')` per route. Add new keys to `src/server/config/permissions.ts`.
4. **Delegate to service**. Never call repos from a route ([spec §11.2](docs/spec/architecture.md#112-responsibility-boundaries)).
5. **Errors**: use factories from `src/server/errors.ts` (`notFound()`, `validationError()`, etc.). Never throw raw `Error`. For bulk operations, translate DB constraint violations to German user-facing messages via the service layer (see `ProjectService.translatePgError()`).
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

One GitHub Actions workflow (`ci.yml`) produces an image; one operator-run script (`scripts/deploy.sh`) promotes it. There is no separate deploy workflow ([ADR-0012](docs/adr/0012-manual-pull-based-deploy-over-wireguard.md)).

**CI** (`.github/workflows/ci.yml`) — triggered on push and PR to `main` and `iteration/**`. Four jobs:

- **`check`** (every event) — in this order: `npm audit` (with the suppressed-advisory handling from [ADR-0007](docs/adr/0007-suppress-esbuild-dev-server-advisory.md)), `npm run lint`, `npm run format:check`, `npx tsc --noEmit`, `bash scripts/check-env-drift.sh` (regression guard that every `env.ts` variable is forwarded via `docker-compose.yml`'s `services.app.environment`; added after `BOOTSTRAP_ADMIN_*` landed in the Zod schema but were forgotten in compose), Postgres service container + in-job MinIO container + `npm run test:coverage` against both, then `npm run build`. Playwright is **not** part of the push/PR gate — the on-demand workflow `.github/workflows/e2e.yml` runs it on `workflow_dispatch` only, so CI green on push does not imply E2E green. See [docs/spec/architecture.md §11.7](docs/spec/architecture.md#117-continuous-delivery-pipeline) and [docs/spec/verification.md AC-37](docs/spec/verification.md#157-engineering).
- **`changes`** — `dorny/paths-filter` detects whether container-relevant files changed; gates the `docker` job so most PRs skip the image build.
- **`docker`** (PRs only, when `changes.docker == true`) — validates `docker compose config` against both the prod file and the prod+dev overlay, then builds the app image with layer caching (no push).
- **`build-and-push`** (push events only, gated on `check`) — builds and pushes the app image to GHCR tagged `sha-<commit>` and `<branch-slug>`. Production images are built in CI, never on the VPS ([ADR-0011](docs/adr/0011-build-images-in-ci-distribute-via-ghcr.md)).

**Deploy** (`scripts/deploy.sh`) — manual, pull-based, run on the VPS by the operator over WireGuard:

1. Operator is already on the VPS (via WireGuard + sudo); invokes `sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [<ref>]`. Default ref is `origin/main`; pass an explicit SHA for rollback.
2. `git fetch origin`, `git checkout <expected-sha>`, assert `HEAD` landed at the expected SHA (hard-coded guard against a silently failed checkout).
3. Decrypt `/opt/projekt-manager/secrets.env.age` via `age -d`, `source <(...)` with `set -a` so the KEY=VALUE lines reach compose. Plaintext is never written to disk.
4. `APP_IMAGE_TAG=sha-<sha> docker compose pull app` — pulls the pre-built image from GHCR (no build on the VPS, per ADR-0011).
5. `docker compose up -d` — swaps the `app` container to the new image; `db`, `storage`, and `caddy` keep running on their pinned images.
6. Smoke test: `docker compose exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"` polls for up to 60 s. Failure dumps the last 50 lines of compose logs and exits non-zero, leaving the previously running version in place.

No automatic deploy. Rationale: [ADR-0012](docs/adr/0012-manual-pull-based-deploy-over-wireguard.md). Day-to-day procedure: [docs/ops/manual-deploy.md](docs/ops/manual-deploy.md). Bootstrap (first-run) procedure: [docs/ops/manual-deploy.md#bootstrap-first-run-on-fresh-vps](docs/ops/manual-deploy.md#bootstrap-first-run-on-fresh-vps).

---

## Design Decisions (Not ADR-Worthy)

- **Export format**: JSON only. `format` parameter reserved for future use.
- **Project number format**: configurable `[C]`, enforced only for uniqueness.
- **Customer duplicates on import**: single-create offers to edit existing; bulk import warns and requires confirmation before overwriting. No merge.
- **Bulk transitions**: not supported. Users transition individually.

---

## Links

| Resource                        | Location                                           |
| ------------------------------- | -------------------------------------------------- |
| Product specification           | [docs/spec/](docs/spec/index.md)                   |
| Architecture Decision Records   | [docs/adr/](docs/adr/index.md)                     |
| Contributing guide and workflow | [CONTRIBUTING.md](CONTRIBUTING.md)                 |
| Vision and kickoff              | [docs/project/kickoff.md](docs/project/kickoff.md) |
| Project journal                 | [docs/project/journal.md](docs/project/journal.md) |
