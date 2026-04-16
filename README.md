# Projekt-Manager

A centralized system for consolidation, control, and viewing of data and processes in small, German-speaking "Handwerker" (tradesman) companies.

## Status

Live at `https://prmng.org` behind WireGuard ([ADR-0008](docs/adr/0008-vpn-first-network-access.md)) with HTTPS via DNS-01 ACME and first-run admin bootstrap ([ADR-0010](docs/adr/0010-first-run-admin-bootstrap.md)). Tech stack: TypeScript + React 19 + Vite + Zustand + Fastify + Drizzle ([ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md)).

## Prerequisites

- Docker and Docker Compose

For local development additionally:

- Node.js (pinned in `.nvmrc` — use `nvm install`)
- npm (use the version bundled with that Node release — do not upgrade independently)

## Quick Start

Three ways to run the app:

|               | [Local dev](#development)       | [Full stack (HTTP)](#full-stack-http) | [Full stack (HTTPS)](#production) |
| ------------- | ------------------------------- | ------------------------------------- | --------------------------------- |
| App           | Node process (`npm run dev`)    | Docker container                      | Docker container                  |
| Reverse proxy | None (Vite proxies `/api/*`)    | Caddy on port 80                      | Caddy on port 443 (TLS)           |
| DB + storage  | Docker                          | Docker                                | Docker                            |
| Domain        | No                              | No                                    | Yes                               |
| TLS           | No (localhost = secure context) | No                                    | Yes (DNS-01 ACME)                 |
| VPN           | No                              | No                                    | Yes (WireGuard)                   |
| Use case      | Day-to-day development          | Evaluate the full stack               | Production                        |

### Development

```bash
cp .env.example .env                  # first time only — dev-ready, no edits needed
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db storage storage-init
npm install
npm run dev                           # starts backend + frontend at http://localhost:5173
```

`storage-init` is a one-shot container that creates the MinIO bucket on first start; it exits after the bucket exists. Skipping it causes `NoSuchBucket` failures in storage tests.

`npm run dev` starts both the Fastify backend (port 3000) and the Vite dev server (port 5173) via `concurrently`. API requests are proxied automatically.

### Full stack (HTTP)

Runs the full production stack (app image, Caddy, Postgres, MinIO) in Docker over plain HTTP — either by pulling the pre-built image from GHCR or building from source. See [docs/ops/http-only-evaluation.md](docs/ops/http-only-evaluation.md) for setup and the two workflow options.

### Production

Full deployment path (each step links to its runbook):

1. [Provision the server](docs/ops/server-setup.md) — OS, SSH, deploy user, Docker, fail2ban, ufw
2. [Set up WireGuard](docs/ops/wireguard-setup.md) — VPN server + first peer
3. [Configure DNS](docs/ops/dns-setup.md) — A record → WireGuard IP (not public IP)
4. [Bootstrap TLS](docs/ops/caddy-tls-bootstrap.md) — first Let's Encrypt cert via staging
5. [Deploy](docs/ops/manual-deploy.md) — clone, configure secrets, `scripts/deploy.sh`

### Seed Data

The `SEED` variable in `.env` controls database seeding on backend startup:

| Value             | Behavior                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `true`            | Seed only if the database is empty. Data you create or change during development survives server restarts. |
| `force`           | Wipe all data and re-seed. Use when seed data structure changes or you need a clean slate.                 |
| `false` (default) | Don't seed.                                                                                                |

Seeding is always skipped in production (`NODE_ENV=production`).

Seed user list and credentials: [docs/ops/local-dev.md § Seed users](docs/ops/local-dev.md#seed-users).

### Tests

Tests require the [development](#development) setup (DB and MinIO exposed on host ports). They do not run against the full-stack Docker variants.

```bash
npm test             # unit + component tests (vitest)
npm run test:e2e     # Playwright E2E tests
```

First-time Playwright setup requires `npx playwright install` to download browser binaries.

## Documentation

- [Architecture](ARCHITECTURE.md) — onboarding overview, read this first
- [Contributing conventions](CONTRIBUTING.md) — code style, workflow
- [Product Spec](docs/spec/index.md) — what the system does (living document)
- [Architecture Decision Records](docs/adr/index.md) — documented big project decisions
- [Kickoff](docs/project/kickoff.md) — project definition, scope, goals, and boundaries
- [Plan](docs/project/plan.md) — development plan and iteration strategy
- [Operator docs](docs/ops/) — server setup, deployment, TLS bootstrap

## Project Structure

```
src/
  api/              API client
  config/           Configuration
  domain/           Shared domain logic
  hooks/            React hooks
  server/           Fastify backend (includes seed data)
  state/            Zustand stores
  test/             Test utilities
  ui/               React components
docs/
  adr/              Architecture Decision Records
  ops/              Operator runbooks (deploy, TLS, server setup)
  project/          Foundational project documents (kickoff, plan, journal)
  spec/             Living product spec (architecture, API, data model, UI)
```

## License

TBD
