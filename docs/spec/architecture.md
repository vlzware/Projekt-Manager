# Architecture, Configuration, NFRs and Security

> **This document is the architectural contract** — what must hold for any code in this repository to be considered correct. For the **navigation guide** (tech stack overview, module map with file paths, request lifecycle, "how to extend" recipes), see [ARCHITECTURE.md](../../ARCHITECTURE.md) at the repo root. The two documents serve different readers: this one is for spec audits, the root one is for finding your way around the code.

---

## 11. Architectural Constraints

### 11.1 Mandatory Constraints

- Type-safe language for both client and server code.
- Testing: unit + component + API integration + at least one E2E smoke test.
- All data mutations go through the API. The front end never accesses the database directly.
- Decisions that need context and rationale are recorded in [ADRs](../adr/index.md). All important implementation choices are visible in [ARCHITECTURE.md](../../ARCHITECTURE.md).

### 11.2 Responsibility Boundaries

The system is organized into seven responsibility layers. The split between **Routes**, **Services**, and **Storage** on the server side is load-bearing — routes never reach into the database directly; they delegate to services, which orchestrate repositories and route every domain-entity mutation through the single-write-path helper (see [§11.3](#113-state-layer-behavioral-contract)).

| Layer        | Responsibility                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config**   | State definitions, thresholds, colors, company assumptions, role definitions, German strings, validated env. Imported by other layers, imports nothing application-internal.                                                                                                                                                                                                                  |
| **Domain**   | Pure functions: transition rules, aging calculation, date/session validation, summary computation, types. Never imports from state, API, routes, services, storage, or UI.                                                                                                                                                                                                                    |
| **Storage**  | Encapsulates all database and object storage operations. Repository modules expose typed query/mutation functions; the object storage client wraps the underlying object-storage SDK. Imported primarily by the Services layer. Exception: authentication middleware reads the session repository directly — architecturally this is part of the route auth hook.                             |
| **Services** | Server-side business logic. Sits between routes and storage: input validation beyond schema, domain-rule enforcement, multi-step orchestration, single-write-path mutation via the helper that commits domain-state change and `audit_log` row atomically (see [§11.3](#113-state-layer-behavioral-contract)). Imports from domain, storage, config. Never imports from routes or middleware. |
| **Routes**   | Thin HTTP adapters: request schema validation, cookie handling, authentication and authorization pre-handlers, response formatting. Delegates all business logic to services. Imports from services, middleware, errors, config. Never imports repositories directly.                                                                                                                         |
| **State**    | Client-side: fetches from and dispatches mutations to the API. Exposes queries for the UI. No direct storage access; no server-side imports.                                                                                                                                                                                                                                                  |
| **UI**       | Presentation only. May import from domain for types. Dispatches actions to the state layer. Never calls the API client directly — only via state. Shared hooks are part of this layer; they wrap store and router primitives so components stay thin. Hooks follow the same import rules as UI components.                                                                                    |

**Dependency direction** (no reverse imports):

```
config  ←  domain  ←  storage  ←  services  ←  routes
                   ←  state    ←  ui
```

The domain layer is shared: both the server (services, routes) and the client (state, UI) import domain types and pure functions. This ensures that type definitions, transition rules, and aging calculations exist in a single place.

**Enforcement:** the layering rules above are the contract. They are enforced by review plus automated linter import restriction zones — a PR that imports storage modules from UI code or repository modules from route code fails lint.

### 11.3 State Layer Behavioral Contract

The state layer is a client-side cache delegating to the API.

**State:** the state layer manages the following data domains:

- **Projects** — the full project list (fetched from API), grouped by workflow state for Kanban rendering.
- **Customers** — the full customer list, used in project forms and the customer management view.
- **Users** — the user list (for admin views and worker assignment dropdowns). Only fetched when needed and when the user has `user:read` permission.
- **Auth** — the authenticated user profile (including theme preference) and session state.
- **View state** — active view, active filter (by workflow state, aged-buffer subset, or custom criteria), selected entity ID for detail views.
- **Mutation tracking** — in-flight flags and error messages per mutation. Confirm-dialog state for transition confirmations.
- **Import state** — parsed envelope, dry-run preview, submission progress, result summary (see [api.md §14.2.4](api.md#1424-unified-data-exchange)).

**Mutations** (per [§11.1](#111-mandatory-constraints)):

- Transition a project forward or backward by one state
- Update a project's planned start/end dates
- Create, update, or soft-delete a project
- Create or update a customer
- Create, update, deactivate, or reactivate a user (admin)
- Reset a user's password (admin); change own password
- Update own preferences (theme preference)
- Export business data / restore from an export envelope (see [api.md §14.2.4](api.md#1424-unified-data-exchange))
- Login / logout
- Fetch or refresh project list, customer list, user list
- Set or clear a filter (local only — no API call)
- Switch between views (local only — clears active filter)

**Queries** (derived from locally cached data):

- Projects grouped by workflow state
- Projects filtered by search, status, customer, date range, or composite criteria
- Customers filtered by search
- Summary: count of projects per action state, count of aged buffer items per state with threshold, count of projects without planned dates
- Current authenticated user and permissions

**Server-side mutation path.** Every domain-entity mutation routes through a single service-layer helper that commits the state change and an `audit_log` row in one database transaction ([data-model.md §5.10](data-model.md#510-audit-log-entity), [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md)). Subscribers — the notification publisher and any future projection — dispatch from the committed audit stream after the transaction commits, so subscriber failure cannot roll back domain state. Bypass is prevented at PR time by a CI-enforced architecture check ([AC-179](verification.md#1523-audit-log)) that rejects raw inserts, updates, or deletes on audited tables outside the helper. Allowlisted paths: migrations, the unified restore path ([api.md §14.2.4](api.md#1424-unified-data-exchange)), business-data seed loaders, and the retention cleanup ([data-model.md §6.10](data-model.md#610-audit-log-retention)). Each allowlist line is a reviewed PR.

### 11.4 Object Storage Module

The object storage module encapsulates all binary/file storage operations. It is wired as an infrastructure module and exercised in test and deployed environments against real object storage.

Capabilities at minimum:

- Upload (key, data, content type) → stored reference
- Download (key) → data stream
- Hide (key) → writes a delete marker on the versioned bucket; the prior version is preserved until lifecycle reap
- Copy-from-version (key, sourceVersionId) → restore primitive; promotes a noncurrent version back to current and returns the freshly-issued current-version id
- Get signed/temporary access URL (key, expiry) → URL

**Capability-split invariant ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).** The storage module's running credential cannot destroy versions. Destruction is a provider-side lifecycle action only — the app key holds write/read/list capabilities but lacks `deleteFiles` (B2) / `s3:DeleteObjectVersion` (MinIO/AWS). A CI architecture check ([verification.md AC-DDD](verification.md#1526-attachments) — number assigned in §15.26 below) refuses any `DeleteObjectCommand` / `DeleteObjectsCommand` carrying a `VersionId` in the codebase, except at the unique boot-probe site (`probeDeleteVersionCapability` in the storage client) which is allowlisted by an AST-based detector keyed on `{ file, functionName }`.

**Boot-time safety probes.** The module runs two refuse-to-serve checks at app start, before any reaper schedules:

- **Bucket-safety probe** — asserts versioning is enabled, Object Lock is in Compliance mode with positive default-retention `R` days, and the lifecycle is exactly one rule applying `daysFromHidingToDeleting = L` with no other lifecycle rules. The validator is a pure function over a structured snapshot, so the fail/warn matrix is unit-tested without mocking the SDK.
- **Capability self-test** — issues a `DeleteObjectCommand` with a sentinel non-existent VersionId against a sentinel key and asserts the response is `AccessDenied`. Any other outcome (success, `NoSuchVersion`, network timeout, unexpected error) fails the boot fail-closed: the credential cannot be trusted, so the app refuses to serve.

**Re-upload semantic — UUID-keyed.** Object keys are server-issued and unique per attachment row: `{projectId}/{attachmentId}.{orig|thumb}`. A re-upload to an existing attachment id is not a supported flow — every upload is a fresh init that produces a new attachment id. This pins the choice ADR-0022 left as two options: with UUID-keyed paths the lifecycle never observes silent overwrites (no PUT-over-existing-key sequence), so the audit chain is always paired to the row and an attachment's full version history maps 1:1 to its row's lifetime. Content-addressed keys were rejected because they couple key schema to bytes and complicate restore semantics (a copy of a hidden version produces a new current version with the same hash, which collides with the content-addressed scheme).

### 11.5 Extensibility Checklist

Structural requirements for the system's documented extension paths. Each row states a contract the codebase must uphold and the failure mode that would close the door.

| Door                                             | Contract                                                                                                                                                                                                                                                                                                                                  | Closed if...                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Adding/removing workflow states                  | States driven by a configuration array, not hardcoded logic                                                                                                                                                                                                                                                                               | Column count or state names are hardcoded in components                                                               |
| Adding new views (worker, bookkeeper, dashboard) | Views consume the shared state layer independently                                                                                                                                                                                                                                                                                        | Kanban and Calendar are coupled to each other                                                                         |
| Adding fields to Project                         | Interface with optional fields; UI tolerates missing data                                                                                                                                                                                                                                                                                 | Components crash on undefined fields                                                                                  |
| Adding file uploads / attachments                | Object storage module exists at the infrastructure layer (§11.4); Project model accepts optional attachments                                                                                                                                                                                                                              | Data layer assumes all project data fits in a single flat object                                                      |
| Adding authentication / roles                    | Authentication and a role-based permission matrix sit behind the API; identity never baked into components                                                                                                                                                                                                                                | User identity baked into component logic                                                                              |
| Adding notifications                             | Post-commit subscribers attach via the single-write-path helper (§11.3); non-mutation events (`backup.failed`, `disk.threshold_reached`) publish to the same bus bypassing audit; rule-matching is data-driven over a closed, code-defined catalog (§11.11, [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md)) | Transitions handled inline in UI event handlers; event classes embedded in handler logic instead of a central catalog |
| Adding a second authentication method            | Auth logic is behind the API; session model is method-agnostic                                                                                                                                                                                                                                                                            | Auth checks are tied to a specific mechanism (e.g., password hashing logic in route handlers)                         |
| Multi-language                                   | All user-facing strings are centralized in configuration; no inline literals in components                                                                                                                                                                                                                                                | Inline literals in components; string configuration bypassed                                                          |
| Adding management views for new entities         | Management views follow a uniform pattern (searchable table + CRUD forms) and consume the shared state layer                                                                                                                                                                                                                              | Entity-specific CRUD logic is wired directly into view components instead of through the state layer and API          |

### 11.6 Deployment Topology

The deployed system consists of four components:

| Component          | Role                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reverse proxy**  | TLS termination, HTTP → HTTPS redirect or non-binding, request forwarding to the application. Production uses automated certificate management — see [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md) and AC-45. The evaluation (HTTP-only) mode substitutes an HTTP-only configuration per [ADR-0013](../adr/0013-http-only-evaluation-mode.md). |
| **Application**    | Serves the front end and exposes the API. Frontend and backend may be a single deployable unit or separate services — this is an ADR decision. The app container listens only on the reverse-proxy-visible network, never on the public interface directly.                                                                                                                             |
| **Database**       | Persistent storage for projects, users, and sessions.                                                                                                                                                                                                                                                                                                                                   |
| **Object storage** | Binary/file storage.                                                                                                                                                                                                                                                                                                                                                                    |

These components may run on the same provider or on separate providers. The spec does not prescribe hosting vendors, managed services, or container strategies — those are ADR decisions. Network topology is further constrained by [ADR-0008](../adr/0008-vpn-first-network-access.md) (VPN-first access) and by the AC-45 HTTPS-or-nothing rule.

Any deployed environment must exercise all four components end-to-end. A topology that omits any of them — e.g. an application-only deploy without the reverse proxy or object storage — does not satisfy the deployment contract.

### 11.7 Continuous Delivery Pipeline

- **CI gate**: runs on every push and PR to protected branches. Pipeline: dependency audit, lint, format check, type check, env-drift check, unit + component + API-integration tests against real database and real object storage, and build. Image is built and pushed to the container registry on push events (not on PRs). E2E tests are **not** part of this gate.
- **On-demand E2E gate**: the E2E test framework runs on manual trigger, with the same database + object storage + seed shape as the CI gate. Intended to be run before a manual deploy. AC-37 in [verification.md §15.7](verification.md#157-engineering) documents the topology from the acceptance-criteria side.
- **Deploy:** manual, pull-based. The operator promotes a CI-built image to the hosted environment over VPN. See [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md).
- A failed deployment must not take down the currently running system. The deploy script polls the health endpoint after container swap.
- Environment separation and rollback mechanisms are documented in [docs/ops/manual-deploy.md](../../docs/ops/manual-deploy.md).

### 11.8 External Integrations

Integrations with external services (e.g., LLM APIs) follow a server-side proxy pattern:

- The external-service credential lives in server-side environment configuration and is never exposed to the browser.
- The browser calls a local API route; the server forwards the request to the external service and relays a sanitized response.
- Upstream failures are mapped to the API's error categories (see [api.md §14.4.1](api.md#1441-error-categories)); internal details (service name, upstream status codes, stack traces) do not leak to the client.
- The Content Security Policy (see [§13.6](#136-security)) is kept tight (`connectSrc: 'self'`) — the proxy pattern is what enables this.

The first integration of this shape is the LLM-based email data extractor (see [ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md), [api.md §14.2.6](api.md#1426-data-extraction), [ui/email-intake.md §8.12](ui/email-intake.md#812-email-data-intake)).

### 11.9 Data persistence and recovery

Persistence and recovery are handled in three independent layers, each scoped to a different class of data. See [ADR-0018](../adr/0018-data-persistence-and-recovery-layered-strategy.md) for the rationale and tradeoffs; the table below is a summary only.

| Layer                  | Captures                                                                  | Trigger                                       | Restore                                                                                                   | Verification                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Business data**      | Customers, projects, project-worker assignments (including archived rows) | Human via UI, `data:export` permission        | Unified restore endpoint ([api.md §14.2.4](api.md#1424-unified-data-exchange)), `data:restore` permission | CI roundtrip: seed → export → wipe → import → export → byte-compare (see AC-141)                                                      |
| **Full DB state**      | Everything in PostgreSQL                                                  | Scheduled job in the `backup` compose service | `pg_restore` from the decrypted backup artifact                                                           | Tier 1 verify-on-create every run; Tier 2 verify-on-cycle when the operator key is loaded ([§11.10](#1110-full-state-backup-layer-2)) |
| **Binary attachments** | Uploaded files                                                            | Continuous, storage-provider-owned            | Provider restore mechanics                                                                                | Provider durability SLA + documented deployment requirements                                                                          |

The layers are complementary, not substitutes — app-level export is not disaster recovery, `pg_dump` is not portable, and binary durability is a storage-provider property. The binary layer's implementation surface is the object storage module ([§11.4](#114-object-storage-module)).

### 11.10 Full-state backup (Layer 2)

The Layer 2 implementation of [§11.9](#119-data-persistence-and-recovery) is a dedicated `backup` compose service that runs on a configurable interval and writes, per run, three artifacts to an off-site object store — the encrypted dump, the encrypted manifest sidecar, and the unencrypted status mirror object — plus upserts a single row in the application database. Rationale, alternatives, consequences, provider choice, tool choice, and key-layout convention live in [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md).

**Topology.**

- The `backup` compose service is scheduled by in-container cron; the compose file is the source of truth ([ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)). The backup interval is configurable **[C]**.
- Each run produces the backup artifact (a full-state database dump, encrypted) and its manifest sidecar (per-table row count and deterministic content checksum, encrypted). The manifest checksum is computed as specified in [ADR-0020 §Decision](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision).
- Retention is linear (provider-enforced bucket lock + lifecycle rule, canonical values at [ADR-0020 §Retention](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention)). No in-container rotation, no weekly/monthly promotion, no object versioning. Scope rationale in the same section.

**Encryption surface.**

- Dumps and manifests are encrypted with an asymmetric recipient. The public recipient key ships in container env; the private identity must never be present on the VPS outside a tmpfs mount ([§13.6](#136-security)).
- For Tier 2 drills, the operator loads the private identity into tmpfs via a helper script; the identity is lost on reboot and never persists to disk.

**Verification (dual tier).**

- **Tier 1 — verify-on-create** runs every backup, unattended. The freshly produced plaintext dump is restored into an ephemeral database instance, container-internal (not a sibling service), the manifest is recomputed, and it is compared to the source manifest. A mismatch fails the run: no upload, and the status surface reports failure.
- **Tier 2 — verify-on-cycle** runs every backup when the operator's identity is present in tmpfs. The just-uploaded encrypted dump is downloaded, decrypted, restored into the ephemeral database instance, and its manifest is compared. When the key is absent, the drill is skipped with a distinct log line; freshness surfaces via the status row rather than as a failure.

**Status surface (dual-write).**

- Primary: the `meta_backup_status` row ([data-model.md §5.9](data-model.md#59-backup-status-entity)), read by the backend on the authenticated admin landing view.
- Mirror: an unencrypted status mirror object in the off-site object store carrying the same fields, readable without the application. This exists so backup health is inspectable during a database outage (operator inspects directly; no application surface required).
- On the authenticated admin landing view, the badge is visible only to callers with role `owner`. The badge surface scales by severity — green is a bare dot with a tooltip; amber, red, and unknown render the full pill with label. Amber and red thresholds are configurable **[C]** (see [§12.2](#122-company-configurable-settings)).
- When the status source is unreachable, the rendering surface MUST display a neutral "status unknown" state — silent absence is a misleading-state defect class ([ADR-0014](../adr/0014-ac-tier-system-critical-vs-design.md)).

### 11.11 Notification Publisher and Dispatch

Process-local projection over two feeds: the post-commit `audit_log` stream (mutation events) and the in-process domain-event bus (non-mutation system events — `backup.failed`, `disk.threshold_reached`). Rationale: [ADR-0021](../adr/0021-audit-log-and-notifications-single-write-path.md) (publisher-over-audit), [ADR-0023](../adr/0023-notification-rules-db-stored-closed-event-catalog.md) (catalog and rule shape).

**Event classification.** The publisher maps audit rows to `NotificationEventClass` ([data-model.md §5.11](data-model.md#511-notification-rule)) via `(entityType, action)` — and `after.status` for transitions. Rows outside the catalog are ignored; this is where the closed catalog is enforced at runtime alongside admin-write validation. Bus events carry their `NotificationEventClass` directly.

**Rule resolution.** For each classified event, the publisher reads enabled rules for the matching `eventClass`, filters by `stateFilter`, and unions recipients across each matching rule's three additive `recipientSpec` parts, deduplicated by `UserAccount.id`. Missing or `active = false` users are dropped; zero live recipients is a no-op.

**Channel selection.** The activity feed always receives the event (`audit_log` for mutations; bus events write a companion feed row so the Aktivität view stays uniform). Push is attempted for each resolved recipient whose `UserAccount.pushMuted` is `false`. Permanent-error responses remove the corresponding subscription ([data-model.md §5.12](data-model.md#512-push-subscription)).

**Failure isolation.** Handlers run post-commit; a throwing handler does not roll back the mutation ([AC-183](verification.md#1523-audit-log)). Per-recipient push failures do not block remaining recipients.

**Push transport.** The real dispatcher wraps the `web-push` npm package and is selected at app composition when VAPID credentials are configured; otherwise a no-op dispatcher is installed with a startup warning. The VAPID public key is derived from the private half at startup and served to the client via an unauthenticated endpoint ([api.md §14.2.10](api.md#14210-push-subscription)); the private key never leaves the server.

### 11.12 Audit Ancestor Link

Each `audit_log` row carries an optional `(ancestorEntityType, ancestorEntityId)` pair alongside its own `(entityType, entityId)`. The pair exists so a per-parent activity feed (project detail) can pull every row scoped to that parent in one indexed predicate — without JSON-path probes or bespoke `projectScope` carve-outs. Both columns are populated atomically with the audit row by the `mutate()` helper; the DB CHECK `audit_log_ancestor_pair` enforces both-or-neither.

**Write-time convention.**

- `entityType = 'project'` rows self-ancestor: `ancestor = ('project', entityId)`.
- Nested entities (`entityType = 'project_worker'`, `entityType = 'attachment'`) set `ancestor = ('project', projectId)` — the id of the owning project is already in scope at every service call site.
- Top-level entities (`entityType = 'customer'`, `entityType = 'user'`) leave the ancestor pair NULL.
- New nested entity types extend the convention by setting their parent ancestor at the service layer; no schema change is required.

**Read path.** The compound index `audit_log_ancestor_idx` on `(ancestor_entity_type, ancestor_entity_id, created_at DESC, id DESC)` serves the project-detail query shape — filter by ancestor pair, order by `createdAt DESC, id DESC` (the list endpoint's tiebreaker from [api.md §14.2.8](api.md#1428-audit-log)). The index key mirrors the ORDER BY so a page is served entirely from the index.

**CHECK closure.** `audit_log_ancestor_type_valid` pins `ancestorEntityType` to the same closed `AuditEntityType` set as `entityType`, keeping the two columns in lock-step when a new entity type lands.

---

## 12. Configuration Boundaries

### 12.1 Universal Domain Rules

Rules that apply to all installations:

- Adjacent-only forward/backward transitions
- Terminal state concept (no transitions out of the final state)
- Aging calculation semantics (days since `statusChangedAt`, compared against a threshold)
- Authentication required for protected access
- Authorization enforced server-side on every protected operation

### 12.2 Company-Configurable Settings

The following values are centralized as single-source constants and may vary per deployment without code changes elsewhere. Each corresponds to a `[C]` marker somewhere in this spec.

- App name, branding, footer text
- Brand accent color — explicit light and dark values (see [§12.5](#125-theming-model))
- Workflow state configuration — labels, colors, order, count, aging thresholds, collapse tiers
- German UI and error strings
- Date and locale display settings
- Project numbering format — year + sequential (see [data-model.md §5.1](data-model.md#51-project-entity))
- Password policy — minimum length, maximum byte length, blocklist
- Session duration
- Role set and per-role permission matrix
- Seed default password
- Restore confirmation phrase — typed by the caller to confirm an override-restore into a non-empty database (see [api.md §14.2.4](api.md#1424-unified-data-exchange))
- Layer 2 backup interval — cadence of the `backup` compose service ([§11.10](#1110-full-state-backup-layer-2))
- Layer 2 freshness thresholds — age of `lastBackupAt` and `lastDrillAt` at which the owner-facing badge switches to amber and to red ([§11.10](#1110-full-state-backup-layer-2))
- Audit log retention window — rolling age at which `audit_log` entries are removed by the scheduled cleanup (default 90 days; see [data-model.md §6.10](data-model.md#610-audit-log-retention))
- Audit activity-feed rendering — mapping from audit entry (`action`, `payload`) ([data-model.md §5.10](data-model.md#510-audit-log-entity)) to the German display string in the activity feed ([ui/workflow-views.md §8.4.1](ui/workflow-views.md#841-activity-feed)) and global Aktivität view ([ui/management.md §8.13](ui/management.md#813-audit-view)). Covers each [`NotificationEventClass`](data-model.md#511-notification-rule) — every catalog event has an `(action, payload)` projection.
- List page size — default row count for paginated list endpoints (projects, customers, users, audit) and their management views
- Rate limit buckets — per-session mutation bucket ceiling for push-subscription mutations (`POST`, `DELETE`); exceeding returns `429 RATE_LIMITED` ([api.md §14.2.10](api.md#14210-push-subscription))
- Attachment per-file size cap — maximum `sizeBytes` of a single attachment original (default 1 MB); enforced by the presigned policy's `content-length-range` and re-verified at complete ([data-model.md §5.13](data-model.md#513-attachment), [api.md §14.2.11](api.md#14211-attachments))
- Attachment bulk-download caps — maximum attachment count and summed byte size per zip stream (default 20 files AND 20 MB); breach rejected with `BULK_LIMIT_EXCEEDED` ([api.md §14.2.11](api.md#14211-attachments), [verification.md AC-216](verification.md#1526-attachments))
- Attachment orphan-reaper TTL — age of a `status = 'pending'` attachment row past which the scheduled reaper removes the row and its backing objects (default 15 minutes; [data-model.md §6.11](data-model.md#611-attachment-orphan-reaper))
- Bulk-download zip TTL — age of a `bulk-downloads/<uuid>.zip` object past which the scheduled sweep removes it from object storage (default 15 minutes; [data-model.md §6.12](data-model.md#612-bulk-download-zip-reaper))
- Attachment presigned-URL expiry — lifetime of upload (presigned-POST) and download (presigned-GET) URLs issued by the attachment surface (default 5 minutes; [api.md §14.2.11](api.md#14211-attachments))
- Attachment worker self-delete grace — elapsed window since upload during which a worker may delete their own attachment (default 15 minutes; outside the window worker delete is rejected with `403 NOT_PERMITTED`; [verification.md AC-215](verification.md#1526-attachments))
- Attachment label catalog — the closed enum `AttachmentLabel` ([data-model.md §5.13](data-model.md#513-attachment)) paired with its German display strings: `angebot` → `Angebot`, `auftragsbestaetigung` → `Auftragsbestätigung`, `rechnung` → `Rechnung`, `aufmass` → `Aufmaß`, `foto` → `Foto`, `sonstiges` → `Sonstiges`. Adding a label is a code change plus a migration (parity with the notification-event catalog).
- Attachment upload CTA labels — German copy for the upload affordance on the project detail page ([ui/project-detail.md §8.15.4](ui/project-detail.md#8154-photo-gallery), [§8.15.5](ui/project-detail.md#8155-binary-list)): the camera-capture CTA (`Foto aufnehmen`), the drop-zone text, the explicit-browse labels, and the retry / dismiss actions. Kept alongside the other `German UI and error strings` — listed here because the CTAs are referenced by capability statements elsewhere in the spec.
- Attachment client-encoding parameters — image-longest-edge, image-quality, thumbnail-longest-edge, thumbnail-quality; applied by the browser pipeline before upload ([ui/project-detail.md §8.15.4](ui/project-detail.md#8154-photo-gallery))
- Compliance retention `R` (days) — bucket default retention auto-applied per upload ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)). Sized for the operator-mistake recovery window. Env var: `STORAGE_OBJECT_LOCK_DAYS`. The dev compose stack mirrors the prod B2 setting via the same var.
- Lifecycle hide-to-delete `L` (days) — `daysFromHidingToDeleting` on the bucket lifecycle rule. The Papierkorb trash window: a hidden version is reaped exactly `L` days after the hide marker lands. Env var: `STORAGE_LIFECYCLE_HIDE_TO_DELETE_DAYS`. **Invariant: `R ≤ L`** — otherwise lifecycle reap retries past retention, the trash window stretches but data is still eventually destroyed; the safety probe surfaces the soft-drift as a warning, not a failure ([ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)).

### 12.3 Configuration Requirements

- Configuration must be represented explicitly, not scattered as literals across the codebase.
- Configuration sources may be static (environment variables, config files), but API and domain boundaries must not assume configuration can only live in source code — the design must permit a move to persisted company settings without restructuring those layers.

### 12.4 User-Configurable Settings

Values controlled per user, independent of the deployment-level configuration in §12.2. Stored on the user record and updated via the self-update API operation.

- Theme preference — `'light' | 'dark' | 'system'`, default `'system'` (see [data-model.md §5.7](data-model.md#57-user-theme-preference))
- Push-mute toggle — boolean, default `false`. When `true`, suppresses push delivery to every subscription owned by the user; activity-feed inclusion is unaffected (see [data-model.md §5.3](data-model.md#53-user-entity), [§5.12](data-model.md#512-push-subscription)).

### 12.5 Theming Model

The visual theme (color scheme) is expressed through a two-layer token system. Components consume only the semantic layer; the primitive layer is an implementation detail.

- **Primitive tokens** — the raw palette, no semantics. Defined once.
- **Semantic tokens** — roles that components reference (surface, text, border, accent, …). Mapped to primitive values.
- **Theme overrides** — a non-default theme (e.g. dark) is a set of semantic-layer overrides scoped by an attribute on the document root. Component stylesheets render different palettes without code changes.
- **Data-driven colors** — state colors from the workflow state configuration remain data-driven and are the single exception to the "no palette values outside the tokens source" rule.
- **Brand accent [C]** — supplied by the branding configuration (§12.2); components consume it via a single semantic token.

### 12.6 Feature Manifest and Operator Confidence

Optional features self-disable when their configuration is incomplete. Without explicit feedback, an operator can complete a deploy and only discover at use time that a feature is silently no-op.

The configuration boundary publishes:

- **A single declared catalog** mapping each feature to the configuration values it requires; the boot manifest's feature list is derived from this catalog.
- **A single read path** — application code reads configuration only through the validated boundary's loader; direct reads from the process environment outside the loader are a narrow, documented exception, not a parallel pattern.
- **A boot-time manifest** — one structured log line per process start enumerating every catalog feature with its state (`enabled` or `disabled`) and a non-empty reason when `disabled`.
- **A pre-flight refusal** — the deploy script validates the loaded configuration against the schema before bringing containers up; a validation failure aborts the deploy and names the offending keys.
- **A schema↔documentation parity check** — the schema's keyspace and the operator-facing example documentation are kept in sync by a CI gate that fails on divergence.

Configuration choices that disable features are the operator's deliberate decisions. Configuration mistakes that silently disable features are bugs. The boundary surfaces both at deploy time and at boot.

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

- Passwords are hashed using a modern, slow hashing algorithm. Plaintext passwords are never stored or logged.
- Session tokens are cryptographically random and opaque. They carry no user data themselves.
- API endpoints validate authentication and authorization on every request. No security-by-obscurity.
- API input is validated and sanitized. No raw user input reaches the database.
- Error messages do not leak internal details (no stack traces, no database field names, no path information).
- HTTPS is required in the deployed environment. The application does not serve over plain HTTP in production. The guarded evaluation mode (see [§13.6.1](#1361-insecure-mode-behavior), [AC-45](verification.md#156-deployment), and [ADR-0013](../adr/0013-http-only-evaluation-mode.md)) is the only documented exception, restricted to non-production environments.

#### 13.6.1 Insecure-mode behavior

When the application is run in insecure (HTTP-only) evaluation mode:

- Session cookies omit the `Secure` attribute so authentication works over plain HTTP.
- HSTS is not sent.
- The Content Security Policy does not upgrade insecure requests.
- The UI shows a non-dismissible warning banner on every page; the browser tab title is prefixed to indicate insecure mode.
- The server refuses to start if insecure mode is active in production (fail-closed).

The activation mechanism (env var, compose override) and CSP wiring details are operational concerns — see [ADR-0013](../adr/0013-http-only-evaluation-mode.md).

### 13.7 Observability

At minimum, the deployed system logs authentication events and API errors to standard output.

### 13.8 Security Checklist for New Endpoints

Every new API endpoint must satisfy:

1. **Authentication**: valid, active session required (see [ADR-0005](../adr/0005-session-management-httponly-cookies.md), [api.md section 14.3](api.md#143-authorization-rules)).
2. **Authorization**: role-based permission check on every protected route.
3. **Input validation**: request schema validation on request body and params (see [api.md section 14.2](api.md#142-operations)). For endpoints accepting composite payloads (e.g., the unified import envelope), per-row semantic validation may live in the service layer per §11.2.
4. **Error handling**: use application error types, no stack traces or DB field names leaked.
5. **Rate limiting**: configured on authentication endpoints (login, password change) and push-subscription mutations (see [api.md §14.2.10](api.md#14210-push-subscription) and §12.2 Rate limit buckets **[C]**). Other mutation endpoints are not rate-limited — at current scale with VPN-only access ([ADR-0008](../adr/0008-vpn-first-network-access.md)), this is a known, accepted limitation.
6. **CSRF protection**: mechanism defined in [ADR-0005](../adr/0005-session-management-httponly-cookies.md).
7. **Password handling**: never log or store plaintext (see [ADR-0006](../adr/0006-password-policy-nist-blocklist.md)).
8. **Ownership derivation on self-scoped surfaces**: on caller-owned resources (e.g., push subscriptions — [api.md §14.2.10](api.md#14210-push-subscription)), the server derives the owning user id from the session; a client-supplied owner id is ignored.
