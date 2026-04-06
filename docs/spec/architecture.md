# Architecture, Configuration, NFRs and Security

*Iteration 2 — April 2026 | Living document — updated as each iteration ships.*

---

## 11. Architectural Constraints

### 11.1 Mandatory Constraints

- Language: **TypeScript** (type safety for the data model is non-negotiable) — applies to both client and server code.
- Testing: unit tests + component tests + API integration tests + at least one E2E smoke test.
- All data mutations go through the API. The front end never accesses the database directly.
- Stack decisions are recorded in ADR documents (see [ADR-0002](../adr/0002-tech-stack-typescript-react-vite-zustand.md) for the front-end stack, [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) for deployment infrastructure, [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md) for the backend stack).

### 11.2 Responsibility Boundaries

The system is organized into six responsibility layers.

| Layer | Responsibility |
|---|---|
| **Config** | State definitions, thresholds, colors, company assumptions, role definitions. Imported by other layers, imports nothing. |
| **Domain** | Pure functions: transition rules, aging calculation, validation, types. Never imports from state, API, storage, or UI. |
| **Storage** | Encapsulates all database and object storage operations. Exposes a repository-style interface. Imported only by the API layer. |
| **API** | Handles authentication, authorization, request validation, and orchestrates storage operations. Exposes the operations defined in [api.md](api.md). Imports from domain and storage. |
| **State** | Fetches from and dispatches mutations to the API. Exposes queries for the UI. No direct storage access. |
| **UI** | Presentation only. May import from domain for types. Dispatches actions to the state layer. |

**Dependency direction** (no reverse imports):

```
config  ←  domain  ←  storage  ←  api
                   ←  state    ←  ui
```

The domain layer is shared: both the API (server-side) and the state layer (client-side) import domain types and pure functions. This ensures that type definitions, transition rules, and aging calculations exist in a single place.

### 11.3 State Layer Behavioral Contract

The state layer is a client-side cache delegating to the API.

**State:** the full project list (fetched from API), the authenticated user, an optional active filter (by workflow state), and the active view (Kanban or calendar).

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

**Known debt**: state actions mutate silently. Future iterations need middleware or event hooks for audit trail and notification triggers.

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

| Door | How it stays open | Closed if... |
|---|---|---|
| Adding/removing workflow states | States driven by configuration array, not hardcoded logic | Column count or state names are hardcoded in components |
| Adding new views (worker, bookkeeper, dashboard) | Views consume the shared state layer independently | Kanban and Calendar are coupled to each other |
| Adding fields to Project | Interface with optional fields; UI tolerates missing data | Components crash on undefined fields |
| Adding file uploads / attachments | Object storage module implemented and tested; Project model accepts optional attachments | Data layer assumes all project data fits in a single flat object |
| Adding authentication / roles | Roles and permissions defined in configuration; API enforces authorization on every request | User identity baked into component logic |
| Adding notifications | State transitions go through a central layer that can be extended with middleware | Transitions are handled inline in UI event handlers |
| Adding project creation / deletion | API and storage contracts support create operations; front-end state layer can accommodate list changes | API designed only for reads + transitions with no room for new operations |
| Extracting Customer entity | Customer is a nested object in Project, ready to be normalized into a separate table with a foreign key | Customer fields are spread across multiple flat columns with no grouping |
| Connecting Worker entities to Users | `assignedWorkers` is a separate field; User entity exists with roles | Worker assignment is an unstructured string with no path to a User reference |
| Adding a second authentication method | Auth logic is behind the API; session model is method-agnostic | Auth checks are tied to a specific mechanism (e.g., password hashing logic in route handlers) |
| Multi-tenancy / multi-company | Configs are per-instance via environment; data model does not preclude adding tenant scoping later | Company names, branding, or workflow definitions are hardcoded in application code |
| Multi-language (low priority) | UI strings are grouped in identifiable locations, not scattered | Strings are inline literals spread across dozens of files |

### 11.6 Deployment Topology

The deployed system consists of three components:

| Component | Role |
|---|---|
| **Application** | Serves the front end and exposes the API. Frontend and backend may be a single deployable unit or separate services — this is an ADR decision. |
| **Database** | Persistent storage for projects, users, and sessions. |
| **Object storage** | Binary/file storage for future attachments. |

These components may run on the same provider or on separate providers. The spec does not prescribe hosting vendors, managed services, container strategies, or network topology — those are ADR decisions.

The deployed demo must exercise the real production topology. The purpose of deploying in this iteration is to validate the full infrastructure path (application, database, object storage all communicating in a hosted environment), not just the application code. A deployment that skips any of the three components does not satisfy the iteration goal.

### 11.7 Continuous Delivery Pipeline

- **Trigger:** merge to `main`.
- **Pre-deploy gate:** the pipeline must run the full test suite (lint, type-check, unit, component, integration) and succeed before deploying.
- **Target:** the hosted environment described in 11.6.
- A failed deployment must not take down the currently running system. The pipeline should support rolling back to the previous version. Specific rollback mechanisms are ADR decisions.
- Environment separation (staging vs. production) and pipeline tooling are ADR decisions.

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

### 12.2 Company-Configurable Settings **[C]**

Values that may differ per customer and must not be hardcoded irreversibly:

- App name, branding, footer text
- Workflow state labels, colors, order, and count
- Aging thresholds (per state type)
- Project numbering format
- Company profile assumptions (trade, team size, region)
- Date and locale display settings
- Initial user and role setup defaults
- Authentication parameters (session duration, password policy)
- *Future:* notification recipients, event rules, per-role permission matrices

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
3. **Input validation**: Fastify JSON schema on request body and params (see [api.md section 14.2](api.md#142-operations)).
4. **Error handling**: use `AppError`, no stack traces or DB field names leaked (see `src/server/errors.ts`).
5. **Rate limiting**: configure on auth and mutation endpoints (see `app.ts` rate-limit setup).
6. **CSRF protection**: `SameSite=Strict` cookies + CSP headers (see [ADR-0005](../adr/0005-session-management-httponly-cookies.md)).
7. **Password handling**: never log or store plaintext (see [ADR-0006](../adr/0006-password-policy-nist-blocklist.md)).

---

*Living document — updated as each iteration ships. Git history preserves past versions.*
