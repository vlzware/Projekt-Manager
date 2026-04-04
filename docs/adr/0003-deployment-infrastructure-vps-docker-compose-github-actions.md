# ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions

- **Status:** Accepted
- **Date:** 2026-04-04
- **Confidence:** High

## Context

Iteration 2 requires deploying three components: the application (frontend + API), a PostgreSQL database, and S3-compatible object storage. The deployment must demonstrate full functionality for a pilot audience while remaining within a near-zero budget (free to ~€5/month).

Key forces:

- **Portability over convenience.** The system is designed for multiple independent deployments (ADR-0001). The same codebase must be runnable on a small demo VPS, a larger production server, or on managed PaaS offerings — without application code changes.
- **Operational simplicity.** A solo developer operates the demo. Juggling dashboards across multiple providers (separate DB host, separate object storage, separate app platform) adds cognitive overhead disproportionate to the scale.
- **Contributor onboarding.** Anyone cloning the repo must be able to run the full stack locally without installing PostgreSQL, MinIO, or other dependencies individually.
- **CI/CD required.** The spec mandates continuous delivery with a pre-deploy test gate (lint, type-check, unit, component, integration tests must pass before any deploy).

## Decision

We will deploy all services on a single VPS using Docker Compose, with GitHub Actions handling CI and triggering deploys via SSH.

**Infrastructure:**

- **VPS** as the deployment target (2 vCPU / 2 GB RAM / 20 GB disk recommended; e.g., Hetzner CX22 at ~€4–6/month).
- **Docker Compose** declares the full stack: application, PostgreSQL, MinIO, and Caddy reverse proxy. The compose file is the single source of truth for what runs and how.
- **PostgreSQL** runs as a Docker container with a mounted volume for persistence. Swappable for any managed PostgreSQL (Supabase, RDS, etc.) by changing the connection string.
- **MinIO** provides S3-compatible object storage as a Docker container. Swappable for Cloudflare R2, AWS S3, or any S3-compatible provider by changing endpoint and credentials.
- **Caddy** serves as reverse proxy with automatic HTTPS via Let's Encrypt. Zero-configuration TLS.

**Deployment pattern:**

- **Monolith.** The backend serves both the API and the static frontend build (Vite output). One service, one URL, no CORS configuration required.

**CI/CD pipeline:**

- **GitHub Actions** runs the full test suite on GitHub's free runners on every push to `main`. The VPS never runs tests.
- **On green:** the action SSHs into the VPS and triggers a pull-and-restart sequence. A dedicated deploy user with restricted permissions holds the SSH key stored as a GitHub secret.
- **Rollback:** re-deploy a previous commit via the same pipeline, or manually on the VPS via `git checkout <sha>` and container restart.

**Portability contract:**

- `docker compose up` runs the complete system — locally, on any VPS, or in any Docker-capable environment.
- Swapping a containerized service for a managed offering requires only environment variable changes, not code changes.

## Alternatives Considered

### PaaS (Render, Railway, Fly.io)

Faster initial setup, managed infrastructure, built-in CI/CD. Ruled out because each provider manages only part of the stack — the database on one, object storage on another, the app on a third — resulting in multiple accounts, dashboards, and billing relationships. Docker Compose provides the same deployment portability without provider coupling. The operational burden of a VPS is proportional to the demo's scale (1–5 users, single server).

### Bare metal on VPS (no Docker)

Fewer abstractions — `apt install` each dependency directly. Ruled out because it requires every contributor and every deployment operator to install and configure the full stack manually (PostgreSQL, Node.js, MinIO, Caddy). Docker Compose reduces this to a single prerequisite (`docker`) and a single command.

### Webhook-based CD (server self-deploys on GitHub webhook)

The server listens for push events and pulls new code itself — no SSH key in GitHub needed. Ruled out for three reasons: tests would run on the VPS (competing with production workload and risking deploys of broken code), the webhook listener is custom infrastructure to write and maintain, and the exposed endpoint adds attack surface. GitHub Actions provides a test gate, execution environment, and log visibility that the webhook approach would need to replicate manually.

### Split deployment (frontend and backend on separate hosts)

Frontend on a static host (Vercel, Netlify), backend on a separate service. Ruled out because it introduces CORS configuration, two CI pipelines, and two services to monitor — complexity without benefit at this scale. The spec supports same-origin serving.

## Consequences

### Positive

- Full control over the entire stack — no provider abstractions to work around
- Reproducible: `docker compose up` runs the identical stack locally and in production
- Portable: swapping any service for a managed alternative requires only config changes
- Cheapest option long-term (~€5/month vs. accumulating free-tier expirations)
- The operator learns what PaaS platforms abstract — transferable knowledge

### Negative

- The operator is the ops team: OS security patches, firewall rules, and monitoring are manual responsibilities (`unattended-upgrades` covers most, not all)
- No redundancy — single server means downtime during hardware failures or maintenance windows
- Database backups must be implemented manually (scheduled `pg_dump` to off-server storage)
- Initial server setup (SSH hardening, Docker, DNS, Caddy) takes longer than a PaaS first deploy

## References

- [ADR-0001: Generalized system with configurable customer specifics](0001-generalized-system-with-configurable-customer-specifics.md)
- [ADR-0002: Tech Stack — TypeScript, React 19, Vite, Zustand](0002-tech-stack-typescript-react-vite-zustand.md)
- [Iteration 2 spec — Deployment](../spec/iteration-2-persistence-auth-deployment.md)
- [Architecture — Responsibility layers](../spec/architecture.md)
