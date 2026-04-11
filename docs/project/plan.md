# Plan

## Iteration 0.A - Discovery

- [x] project definition
- [x] preliminary discussions with the target company[^1]
- [x] realization of scope and setting limits
- [x] consideration of approaching the project as a general solution for a wider audience

**Artifacts**

- [x] Kickoff document

## Iteration 0.B - Clarification

- [x] meetings with stakeholders, clarification of details and ambiguities[^1]
- [x] meeting with owner, clarification of roles and rights[^1]
- [x] clarification of data, fields, types and their relations[^1]

**Artifacts**

- [x] definition of a "walking skeleton"
- [x] detailed specification for the implementation of a "walking skeleton"
- [x] interactive prototypes (code-based; replaces traditional wireframes — iterating in code is faster for well-established UI patterns like calendar and Kanban)

## Iteration 0.C - Pre-Work Setup

- [x] separation of the work into modules
- [x] setting up an environment, coding style, and workflow

**Artifacts**

- [x] Git repository initialized.
- [x] A GitHub Kanban board set up.
- [x] CONTRIBUTING.md with conventions, code style, branching strategy

> **Note:** Stack-dependent tooling (linter, test framework, CI, quality gates) could not be set up until the tech stack was decided in iteration 1. These items are tracked as iteration 1 issues (#19–#21).

Environment setup recurs whenever an iteration introduces new technology (e.g., backend, hosting).

## Iteration 1 - Walking Skeleton

- [x] parallel prototyping of 5 tech stacks (React+FullCalendar+shadcn, React+Custom, Svelte 5, Vue 3, PHP)
- [x] empirical evaluation: page weight, LOC, build time, configurability audit
- [x] tech stack decision formalized as ADR-0002
- [x] presentation to pilot company[^1] — positive validation of information architecture
- [x] chosen implementation (React, Prototype B) promoted to the iteration branch, all tests passing
- [x] linter, formatter, test framework, quality gates
- [x] CI pipeline: lint, type-check, test on every push
- [x] retrospection → issues for the backlog

**Artifacts**

- [x] a "walking skeleton" (prototype stage — 5 implementations)
- [x] presentation[^1]
- [x] production-quality walking skeleton on chosen stack

## Iteration 2 - Infrastructure foundation: backend, auth, storage, Docker, CI/CD

- [x] API layer between frontend and data
- [x] a module encapsulating all storage operations (S3 SDK)
- [x] user authentication
- [x] replace mock data with a persistent data source in a database
- [x] extensive quality and security reviews — the biggest timesink
- [x] retrospection → workflow improvements (security audit step, journal cleanup, memory consolidation)

Deployment deferred to iteration 3 — security review revealed the codebase wasn't ready for exposure.
Presentation skipped — no visible difference for non-technical users vs the walking skeleton; the massive backend/security work is invisible at the UI level.

**Artifacts**

- realistic app with persistent data and authentication
- security-hardened foundation for deployment

## Iteration 3 - Stabilization

Structural refactor triggered by code quality analysis that exposed compounding debt from iterations 1–2. Feature work halted to establish a clean baseline before production deployment.

- [x] multi-angle code quality audit (5 parallel agents: spec, backend, frontend, infra, coupling)
- [x] backend: service layer (AuthService, ProjectService), repository split, centralized config, Zod env validation
- [x] frontend: API client extraction (eliminated 3× fetch duplication), Zustand store split into auth/project/ui slices, shared transition hook
- [x] routing: React Router for URL-based navigation
- [x] testing: +50 tests (136 → 186), test file split, shared DB setup helper, seed race fix
- [x] docs: ARCHITECTURE.md, spec security checklist, known debt index, iteration scope mapping
- [x] infra: MinIO bucket init container, DB indexes
- [x] retrospection → journal entry, workflow learnings (agent isolation, spec-implementation gap as quality signal)

**Artifacts**

- structurally sound codebase ready for production deployment
- documented architecture and onboarding entry point
- validated extensibility: config-driven states, independent view composition

## Iteration 4 - Deployment and integration testing

Moved the iteration-3 codebase from test environment into production on Hetzner. Focus ended up on the network and TLS architecture: HTTPS over WireGuard via DNS-01 ACME, Caddy bound to the VPN interface only, no cleartext exposure outside Docker internals, external surface limited to trusted audited open-source (SSH, WireGuard). No application features moved; everything around them did.

- [x] deploy to Hetzner VPS (Docker Compose, Caddy with real domain + TLS)
- [ ] object storage: evaluate Cloudflare R2 vs Hetzner Object Storage — deferred (#45); MinIO in Docker is sufficient for the walking skeleton
- [x] VPN setup (plain WireGuard, [ADR-0008](../adr/0008-vpn-first-network-access.md)) — all access behind VPN initially
- [x] validate full deployment path: push to main → CI green → auto-deploy → app running
- [x] integration/smoke tests against the deployed environment
- [ ] backup strategy for PostgreSQL and object storage — deferred (#46); needed before real customer data, not before walking skeleton
- [ ] monitoring: at minimum, health check pings and container restart alerting — deferred (#46)
- [ ] seed with representative fake data, demo to pilot company[^1] — skipped; no visible change for non-technical users vs iteration 3
- [x] retrospection → issues for the backlog

**Beyond plan**

- first-run admin bootstrap from environment variables ([ADR-0010](../adr/0010-first-run-admin-bootstrap.md)) — the walking skeleton had no way to log in on a fresh production deploy
- env-drift CI check — regression guard for the bootstrap failure mode (compose ↔ env schema)
- Docker version pinning across environments ([ADR-0009](../adr/0009-pin-docker-versions-across-environments.md))
- CD pipeline hardening (#48) partially addressed via the env-drift check; rest deferred to iteration 5

**Artifacts**

- walking skeleton live at `https://prmng.org`, reachable only through WireGuard
- validated CI/CD pipeline from commit to production (8 successful deploys this iteration)
- 310 tests (up from 186), new suites for first-run bootstrap and password policy

## Iteration 5 - Consolidation

Systematic check that the base is aligned and nothing is lagging or missing before adding features. The walking skeleton is online; the next iterations will add flesh to the bones. Constant readjustments like this are the expected rhythm in an LLM-driven project, where drift between ideal and reality accumulates quickly and compounds into tech debt if left unchecked.

- [ ] test suite QC — coverage gaps, fragile assertions, tautological tests, redundant/repeating tests, test-spec drift
- [ ] documentation QC and reorganization — audit ADRs, dev docs, admin docs, user docs; reorganize the docs tree; fill gaps
- [ ] spec ↔ code drift reconciliation — realign the spec against current code, cleanup stale claims
- [ ] multi-round independent security review — systematic audit across backend, frontend, infrastructure, deployment, data handling
- [ ] cleanup of open non-architectural, non-feature issues — tracked via the iteration 5 milestone
- [ ] retrospection → issues for the backlog

**Not planned:** presentation to pilot company — same reason as iteration 4: no visible change for non-technical users. The next iteration with feature work is the natural next demo checkpoint.

**Artifacts**

- quality-controlled test suite, docs, and spec
- documented baseline after a multi-round independent security review
- backlog reduced to feature and architectural work

## Next iterations

presentation[^1] -> scope for the next iteration -> specification -> tests -> implementation -> presentation[^1] ...
until all goals, defined in the Definition of Done, are achieved (see [Done when](kickoff.md#done-when-final-product))

## Time allocation

We plan to use different LLMs in a custom workflow for most of the implementation work. Thus, we expect that the most time-consuming part of the project will be the clarification of goals, definition of the current scope, integration and quality control. We plan to start with a 3-day slot for an iteration cycle, which may be adjusted as needed.

[^1]: For this Open-Source repository, no real company data will be used and thus reasonable assumptions are to be made. See [Company specifics](kickoff.md#company-specifics)
