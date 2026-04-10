# Projekt-Manager

A centralized system for consolidation, control, and viewing of data and processes in small, German-speaking "Handwerker" (tradesman) companies.

## Status

**Iteration 5 — Consolidation**: quality controls across tests, docs, and spec before the next round of feature work. Walking skeleton live at `https://prmng.org` behind WireGuard ([ADR-0008](docs/adr/0008-vpn-first-network-access.md)) with HTTPS via DNS-01 ACME and first-run admin bootstrap ([ADR-0010](docs/adr/0010-first-run-admin-bootstrap.md)). Tech stack: TypeScript + React 19 + Vite + Zustand + Fastify + Drizzle ([ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md)).

## Prerequisites

- Docker and Docker Compose

For local development additionally:
- Node.js (pinned in `.nvmrc` — use `nvm install`)
- npm (use the version bundled with that Node release — do not upgrade independently)

## Quick Start

### Production

```bash
cp .env.production.example .env   # fill in values, see docs/ops/server-setup.md
docker compose up -d
```

Caddy terminates TLS on port 443 and reverse-proxies to the application on port 3000.

### Development

```bash
cp .env.example .env                  # first time only — dev-ready, no edits needed
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db storage storage-init
npm install
npm run dev                           # starts backend + frontend at http://localhost:5173
```

`storage-init` is a one-shot container that creates the MinIO bucket on first start; it exits after the bucket exists. Skipping it causes `NoSuchBucket` failures in storage tests.

`npm run dev` starts both the Fastify backend (port 3000) and the Vite dev server (port 5173) via `concurrently`. API requests are proxied automatically.

### Seed Data

The `SEED` variable in `.env` controls database seeding on backend startup:

| Value | Behavior |
|---|---|
| `true` | Seed only if the database is empty. Data you create or change during development survives server restarts. |
| `force` | Wipe all data and re-seed. Use when seed data structure changes or you need a clean slate. |
| `false` (default) | Don't seed. |

Seeding is always skipped in production (`NODE_ENV=production`).

All seed users share the password **`changeme`**.

| Username | Display Name | Role |
|---|---|---|
| `inhaber` | Thomas Berger | owner |
| `buero` | Maria Schmidt | office |
| `arbeiter1` | Jan Nowak | worker |
| `arbeiter2` | Lukas Fischer | worker |
| `buchhalter` | Petra Weiß | bookkeeper |
| `deaktiviert` | Ehemaliger Mitarbeiter | worker (inactive) |

### Tests

```bash
npm test             # unit + component tests (vitest)
npm run test:e2e     # Playwright E2E tests
```

First-time Playwright setup requires `npx playwright install` to download browser binaries.

## Documentation

- [Architecture](ARCHITECTURE.md) — onboarding overview, read this first
- [Contributing conventions](CONTRIBUTING.md) — code style, workflow, branching, issues
- [Product Spec](docs/spec/index.md) — what the system does (living document)
- [Architecture Decision Records](docs/adr/index.md) — documented project decisions
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
