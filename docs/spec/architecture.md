# Architecture, Configuration, NFRs and Security

> **This document is the architectural contract** — what must hold for any code in this repository to be considered correct. For the **navigation guide** (tech stack overview, module map with file paths, request lifecycle, "how to extend" recipes), see [ARCHITECTURE.md](../../ARCHITECTURE.md) at the repo root. The two documents serve different readers: this one is for spec audits, the root one is for finding your way around the code.

---

## 11. Architectural Constraints

### 11.1 Mandatory Constraints

- Language: **TypeScript** (type safety for the data model is non-negotiable) — applies to both client and server code.
- Testing: unit tests + component tests + API integration tests + at least one E2E smoke test.
- All data mutations go through the API. The front end never accesses the database directly.
- Stack decisions are recorded in ADR documents (see [ADR-0002](../adr/0002-tech-stack-typescript-react-vite-zustand.md) for the front-end stack, [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) for deployment infrastructure, [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md) for the backend stack).

### 11.2 Responsibility Boundaries

The system is organized into seven responsibility layers. The split between **Routes**, **Services**, and **Storage** on the server side is load-bearing — routes never reach into the database directly; they delegate to services, which orchestrate repositories and emit domain events.

| Layer        | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config**   | State definitions, thresholds, colors, company assumptions, role definitions, German strings, validated env. Imported by other layers, imports nothing application-internal.                                                                                                                                                                                                                                               |
| **Domain**   | Pure functions: transition rules, aging calculation, date/session validation, summary computation, types. Never imports from state, API, routes, services, storage, or UI.                                                                                                                                                                                                                                                 |
| **Storage**  | Encapsulates all database and object storage operations. Repository modules (`src/server/repositories/`) expose typed query/mutation functions; the object storage client (`src/server/storage/`) wraps the S3 SDK. Imported primarily by the Services layer. Exception: authentication middleware (`src/server/middleware/`) reads the session repository directly — architecturally this is part of the route auth hook. |
| **Services** | Server-side business logic. Sits between routes and storage: input validation beyond schema, domain-rule enforcement, multi-step orchestration, event emission via `services/events.ts`. Imports from domain, storage, config. Never imports from routes or middleware.                                                                                                                                                    |
| **Routes**   | Thin HTTP adapters: Fastify schema validation, cookie handling, preHandlers (`authenticate`, `requirePermission`), response formatting. Delegates all business logic to services. Imports from services, middleware, errors, config. Never imports repositories directly.                                                                                                                                                  |
| **State**    | Client-side: fetches from and dispatches mutations to the API. Exposes queries for the UI. No direct storage access; no server-side imports. Stores live in `src/state/`.                                                                                                                                                                                                                                                  |
| **UI**       | Presentation only. May import from domain for types. Dispatches actions to the state layer. Never calls the API client directly — only via state. Shared React hooks (`src/hooks/`) — e.g. `useProjectTransition`, `useRouterNav` — are part of this layer; they wrap store and router primitives so components stay thin. Hooks follow the same import rules as UI components.                                            |

**Dependency direction** (no reverse imports):

```
config  ←  domain  ←  storage  ←  services  ←  routes
                   ←  state    ←  ui
```

The domain layer is shared: both the server (services, routes) and the client (state, UI) import domain types and pure functions. This ensures that type definitions, transition rules, and aging calculations exist in a single place.

**Enforcement:** the layering rules above are the contract. As of iteration 5 they are enforced by review plus automated `no-restricted-imports` ESLint zones — a PR that imports `src/server/db/schema.js` from `src/ui/**` or `src/server/repositories/**` from `src/server/routes/**` fails lint. See [`eslint.config.js`](../../eslint.config.js) for the authoritative zone list.

### 11.3 State Layer Behavioral Contract

The state layer is a client-side cache delegating to the API.

**State:** the full project list (fetched from API), the authenticated user, an optional active filter (by workflow state or aged-buffer subset), the active view (Kanban or Kalender), a confirm-dialog store (modal state for transition confirmations), mutation tracking (in-flight flag, error message), selected project ID (detail panel), and session-checked flag.

**Mutations** (all persisted mutations go through the API):

- Transition a project forward or backward by one state → call API, update local state on success
- Update a project's planned start/end dates → call API, update local state on success
- Login / logout → call API, update auth state
- Fetch all projects → call API, replace local project list
- Set or clear a filter by workflow state (local only — no API call)
- Switch between views (local only — clears active filter)

**Queries** (derived from locally cached data):

- Projects grouped by workflow state
- Summary: count of projects per action state, count of aged buffer items per state with threshold, count of projects without planned dates
- Current authenticated user

The server-side event bus (`events.ts`) provides the hook mechanism — `project.transitioned` and `project.dates_changed` events are emitted. Remaining: connect actual subscribers (audit logger, notification sender). Client-side state middleware is not yet implemented.

### 11.4 Object Storage Module

The object storage module encapsulates all binary/file storage operations. Implemented and tested in this iteration but not connected to UI (see [kickoff](../project/kickoff.md): worker uploads, Aufmass, photos are future iterations). The deployed demo tests this module against real infrastructure.

Capabilities at minimum:

- Upload (key, data, content type) → stored reference
- Download (key) → data stream
- Delete (key) → success/failure
- Get signed/temporary access URL (key, expiry) → URL

Connecting it to UI later should require only adding an API endpoint and a UI component — the storage plumbing must already work.

### 11.5 Extensibility Checklist

The system must not close doors that later iterations need open.

| Door                                             | How it stays open                                                                                                                                                                        | Closed if...                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Adding/removing workflow states                  | States driven by configuration array, not hardcoded logic                                                                                                                                | Column count or state names are hardcoded in components                                       |
| Adding new views (worker, bookkeeper, dashboard) | Views consume the shared state layer independently                                                                                                                                       | Kanban and Calendar are coupled to each other                                                 |
| Adding fields to Project                         | Interface with optional fields; UI tolerates missing data                                                                                                                                | Components crash on undefined fields                                                          |
| Adding file uploads / attachments                | Object storage module implemented and tested; Project model accepts optional attachments                                                                                                 | Data layer assumes all project data fits in a single flat object                              |
| Adding authentication / roles                    | Implemented: 4 roles (owner, office, worker, bookkeeper) with a permission matrix. API enforces `requirePermission()` on protected routes.                                               | User identity baked into component logic                                                      |
| Adding notifications                             | Server-side event bus implemented (`events.ts`). Subscribers can be added without changing the transition logic.                                                                         | Transitions are handled inline in UI event handlers                                           |
| Adding project creation / deletion               | Bulk import endpoint implemented (`POST /api/projects/bulk/import`). Single-item create and delete are the remaining doors.                                                              | API designed only for reads + transitions with no room for new operations                     |
| Extracting Customer entity                       | Customer is a nested object in Project, ready to be normalized into a separate table with a foreign key                                                                                  | Customer fields are spread across multiple flat columns with no grouping                      |
| Connecting Worker entities to Users              | `project_workers` join table links projects to `UserAccount` with FK constraints                                                                                                         | Worker assignment is an unstructured string with no path to a User reference                  |
| Adding a second authentication method            | Auth logic is behind the API; session model is method-agnostic                                                                                                                           | Auth checks are tied to a specific mechanism (e.g., password hashing logic in route handlers) |
| Multi-tenancy / multi-company                    | Configs are per-instance via environment; data model does not preclude adding tenant scoping later                                                                                       | Company names, branding, or workflow definitions are hardcoded in application code            |
| Multi-language (low priority)                    | Partially open: German strings are being extracted to `src/config/strings.ts`. Extraction is in progress — some call sites still use inline literals. A full i18n framework is deferred. | Extraction regresses to inline literals; strings.ts is abandoned                              |

### 11.6 Deployment Topology

The deployed system consists of four components:

| Component          | Role                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Reverse proxy**  | TLS termination, HTTP → HTTPS redirect or non-binding, request forwarding to the application. Production uses Caddy with Cloudflare DNS-01 ACME — see [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) and AC-45. The evaluation (HTTP-only) mode substitutes `Caddyfile.http` per [ADR-0013](../adr/0013-http-only-evaluation-mode.md). |
| **Application**    | Serves the front end and exposes the API. Frontend and backend may be a single deployable unit or separate services — this is an ADR decision. The app container listens only on the reverse-proxy-visible network, never on the public interface directly.                                                                                                                    |
| **Database**       | Persistent storage for projects, users, and sessions.                                                                                                                                                                                                                                                                                                                          |
| **Object storage** | Binary/file storage for future attachments.                                                                                                                                                                                                                                                                                                                                    |

These components may run on the same provider or on separate providers. The spec does not prescribe hosting vendors, managed services, or container strategies — those are ADR decisions. Network topology is further constrained by [ADR-0008](../adr/0008-vpn-first-network-access.md) (VPN-first access) and by the AC-45 HTTPS-or-nothing rule.

The deployed demo must exercise the real production topology. The purpose of deploying in this iteration is to validate the full infrastructure path (reverse proxy, application, database, object storage all communicating in a hosted environment), not just the application code. A deployment that skips any of the four components does not satisfy the iteration goal.

### 11.7 Continuous Delivery Pipeline

- **CI trigger:** push or PR to `main` and `iteration/**` branches.
- **CI gate (`.github/workflows/ci.yml`):** the pipeline runs `npm audit`, lint, format check, type check, env-drift check, unit + component + API-integration tests against real Postgres and real MinIO, and `npm run build`. Image is built and pushed to GHCR on push events (not on PRs). Playwright is **not** part of this gate — see below.
- **On-demand E2E (`.github/workflows/e2e.yml`):** Playwright runs manually via the "Run workflow" button in the Actions tab. Same postgres-service + MinIO + seed shape as `ci.yml`, plus `npx playwright test`. Rationale: pushing Playwright into the push/PR gate would add multi-minute runtime and a retry-flakiness surface the project cannot afford to debug while shipping features; leaving it local-only means regressions go unnoticed until the next local run. The manual job is the compromise — one click away before a manual deploy. AC-37 in [verification.md §15.7](verification.md#157-engineering) documents the topology from the acceptance-criteria side.
- **Deploy:** manual, pull-based. The operator promotes a CI-built image to the hosted environment over WireGuard. See [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md).
- A failed deployment must not take down the currently running system. The deploy script polls the health endpoint after container swap.
- Environment separation and rollback mechanisms are documented in [docs/ops/manual-deploy.md](../../docs/ops/manual-deploy.md).

---

## 12. Configuration Boundaries

Per [ADR-0001](../adr/0001-generalized-system-with-configurable-customer-specifics.md) and the [kickoff](../project/kickoff.md), company-specific assumptions must remain adjustable. This section distinguishes what is universal from what is company-configurable.

### 12.1 Universal Domain Rules

Rules that define the generic workflow behavior of the product — these apply to all installations:

- Adjacent-only forward/backward transitions
- Terminal state concept (no transitions out of the final state)
- Aging calculation semantics (days since `statusChangedAt`, compared against a threshold)
- Authentication required for protected access
- Authorization enforced server-side on every protected operation

### 12.2 Company-Configurable Settings

The following values are centralized as single-source constants in `src/config/` (client) or `src/server/config/` (server) and may vary per deployment without code changes elsewhere. Each corresponds to a `[C]` marker somewhere in this spec.

- App name, branding, footer text (`src/config/brandingConfig.ts`)
- Workflow state configuration — labels, colors, order, count, aging thresholds, collapse tiers (`src/config/stateConfig.ts`)
- German UI and error strings (`src/config/strings.ts`)
- Date and locale display settings (`src/config/localeConfig.ts`)
- Project numbering format — year + sequential (see [data-model.md §5.1](data-model.md#51-project-entity))
- Password policy — minimum length, maximum byte length, blocklist (`src/server/config/password-policy.ts`)
- Session duration (`src/server/config/index.ts`)
- Role set and per-role permission matrix (`src/server/config/permissions.ts`)
- Seed default password (`src/test/seedAssumptions.ts`)

### 12.3 Configuration Requirements

- Configuration must be represented explicitly, not scattered as literals across the codebase.
- The system may start with static configuration sources (e.g., environment variables, config files), but API and domain boundaries must not assume configuration can only ever live in source code — the design must permit moving to persisted company settings in later iterations.

---

## 13. Non-Functional Requirements

### 13.1 Usability

- Understandable by non-technical users in a demo context.
- Main actions discoverable without training.
- State type distinction (action/buffer) visually obvious at a glance.

### 13.2 Performance

- Initial page load (after login) under 3 seconds on typical broadband.
- API response time for list operations under 500ms for up to 100 projects.
- API response time for mutations under 300ms.
- User actions reflected in the UI within 200ms (optimistic updates permitted; server confirmation may follow).
- The architecture must not preclude scaling to 200+ projects and multiple concurrent users.

### 13.3 Maintainability

- Domain types separated from UI components.
- Warning/aging logic separated from presentation.
- **API contract separated from transport implementation.**
- **Storage operations abstracted behind a module boundary.**
- **Database schema migrations versioned and reproducible.**
- State configuration (labels, colors, thresholds) centralized, not scattered.

### 13.4 Accessibility

Not full compliance, but minimally:

- Sufficient color contrast for state indicators.
- Warning information not conveyed by color alone (text labels accompany colors).
- Keyboard navigation for primary interactions where practical.

### 13.5 Robustness

The UI must tolerate incomplete project data without crashing:

- Missing dates (project appears in Kanban but not calendar).
- Missing address, phone, email (detail panel shows available fields only).
- Missing notes (field simply absent).

**The system must handle failure gracefully:**

- **Network errors during API calls display a user-friendly German message and do not corrupt local state.**
- **Session expiry mid-use redirects to login without data loss** (unsaved changes are inherently impossible — every mutation is sent to the API immediately).
- **The API rejects malformed requests with clear error codes, never with stack traces or internal details.**

### 13.6 Security

- Passwords are hashed using a modern, slow hashing algorithm (bcrypt, argon2, or equivalent). Plaintext passwords are never stored or logged.
- Session tokens are cryptographically random and opaque. They carry no user data themselves.
- API endpoints validate authentication and authorization on every request. No security-by-obscurity.
- API input is validated and sanitized. No raw user input reaches the database.
- Error messages do not leak internal details (no stack traces, no database field names, no path information).
- HTTPS is required in the deployed environment. The application does not serve over plain HTTP in production.

### 13.7 Observability

Logging and monitoring requirements are deferred. At minimum, the deployed system should log authentication events and API errors to standard output for basic troubleshooting.

### 13.8 Security Checklist for New Endpoints

Every new API endpoint must satisfy:

1. **Authentication**: valid, active session required (see [ADR-0005](../adr/0005-session-management-httponly-cookies.md), [api.md section 14.3](api.md#143-authorization-rules)).
2. **Authorization**: role-based permission check via `requirePermission()` (see `src/server/config/permissions.ts`).
3. **Input validation**: Fastify JSON schema on request body and params (see [api.md section 14.2](api.md#142-operations)). For bulk operations, per-item semantic validation may live in the service layer per §11.2.
4. **Error handling**: use `AppError`, no stack traces or DB field names leaked (see `src/server/errors.ts`).
5. **Rate limiting**: configured on authentication endpoints (login, password change). Mutation endpoints are not rate-limited — at current scale with VPN-only access ([ADR-0008](../adr/0008-vpn-first-network-access.md)), this is a known, accepted limitation.
6. **CSRF protection**: `SameSite=Strict` cookies + CSP headers (see [ADR-0005](../adr/0005-session-management-httponly-cookies.md)).
7. **Password handling**: never log or store plaintext (see [ADR-0006](../adr/0006-password-policy-nist-blocklist.md)).
