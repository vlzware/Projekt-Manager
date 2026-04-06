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

## How to Extend

### Adding a new entity (e.g., Supplier)

1. **Schema**: add table in `src/server/db/schema.ts`, generate migration with `npx drizzle-kit generate`
2. **Domain types**: add TypeScript interface in `src/domain/types.ts`
3. **Repository**: create `src/server/repositories/supplier.ts` with CRUD functions
4. **Routes**: create `src/server/routes/suppliers.ts`, register in `src/server/app.ts`
5. **State**: add `src/state/supplierStore.ts` (follows authStore/projectStore pattern)
6. **UI**: add components under `src/ui/suppliers/`
7. **Tests**: unit tests in `src/domain/__tests__/`, API tests in `src/server/__tests__/`, component tests in `src/ui/__tests__/`
8. **Seed data**: update `src/server/seed.ts` if demo data is needed

### Adding a new view (e.g., Worker view)

1. Create components under `src/ui/worker/`
2. Add a view option to the state store (follows the existing Kanban/Calendar pattern)
3. Consume existing state queries -- the store already exposes project data grouped by state
4. No backend changes needed if the view uses existing data

### Adding a new API endpoint

1. Create or extend a route file in `src/server/routes/`
2. Register the route in `src/server/app.ts`
3. Use existing middleware (`src/server/middleware/auth.ts`) for auth
4. Call repositories for data access -- never query the DB directly in route handlers
5. Add integration tests in `src/server/__tests__/`

### Adding a new workflow state

1. Update the state array in `src/config/stateConfig.ts` (name, type, color, threshold)
2. No code changes required -- the Kanban board, transitions, and aging logic are all config-driven
3. Run seed migration if existing data needs the new state

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
