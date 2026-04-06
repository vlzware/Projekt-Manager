# Projekt-Manager

A centralized system for consolidation, control, and viewing of data and processes in small, German-speaking "Handwerker" (tradesman) companies.

## Status

**Iteration 3 — Production**: Full-stack application with service layer, split stores, and centralized API client. Fastify backend, PostgreSQL, MinIO object storage, and Caddy reverse proxy — deployed via Docker Compose. Tech stack: TypeScript + React 19 + Vite + Zustand + Fastify + Drizzle ([ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md)).

## Prerequisites

- Docker and Docker Compose

For local frontend development additionally:
- Node.js (pinned in `.nvmrc` — use `nvm install`)
- npm (use the version bundled with that Node release — do not upgrade independently)

## Quick Start

### Production

```bash
cp .env.example .env   # edit secrets before deploying
docker compose up -d
```

The app is served by Caddy on ports 80/443. The application itself listens on port 3000.

### Development

```bash
cp .env.example .env                  # first time only — edit passwords if desired
docker compose -f docker-compose.yml -f docker-compose.dev.yml up db storage
npm install
npm run dev                           # starts backend + frontend at http://localhost:5173
```

`npm run dev` starts both the Fastify backend (port 3000) and the Vite dev server (port 5173) via `concurrently`. API requests are proxied automatically. To use a custom frontend port: `npm run dev:client -- --port 3005`.

### Seed Data

The `SEED` variable in `.env` controls database seeding on backend startup:

| Value | Behavior |
|---|---|
| `true` (default) | Seed only if the database is empty. Data you create or change during development survives server restarts. |
| `force` | Wipe all data and re-seed. Use when seed data structure changes or you need a clean slate. |
| `false` / unset | Don't seed. |

Seeding is always blocked in production (`NODE_ENV=production`).

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
npm test             # unit + component tests
npm run test:e2e     # Playwright E2E tests
```

First-time Playwright setup requires `npx playwright install` to download browser binaries.

## Documentation

- [Kickoff](docs/project/kickoff.md) — project definition, scope, goals, and boundaries
- [Plan](docs/project/plan.md) — development plan and iteration strategy
- [Architecture Decision Records](docs/adr/index.md) — documented project decisions
- [Product Spec](docs/spec/index.md) — what the system does (living document)
- [Contributing conventions](CONTRIBUTING.md) — code style, workflow, branching, issues

## Project Structure

```
src/
  ui/               React components
  state/            Zustand stores
  server/           Fastify backend
  domain/           Shared domain logic
  config/           Configuration
  data/             Seed data
  test/             Test utilities
docs/
  spec/             Living product spec (architecture, API, data model, UI)
  project/          Foundational project documents (kickoff, plan, journal)
  adr/              Architecture Decision Records
```

## License

TBD
