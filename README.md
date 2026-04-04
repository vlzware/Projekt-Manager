# Projekt-Manager

A centralized system for consolidation, control, and viewing of data and processes in small, German-speaking "Handwerker" (tradesman) companies.

## Status

**Iteration 2 — Deployment**: Full-stack application with Fastify backend, PostgreSQL, MinIO object storage, and Caddy reverse proxy — deployed via Docker Compose. Tech stack: TypeScript + React 19 + Vite + Zustand + Fastify + Drizzle ([ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md)).

## Prerequisites

- Docker and Docker Compose

For local frontend development additionally:
- Node.js >= 22 (see `.nvmrc`)
- npm >= 10

## Quick Start

### Production

```bash
cp .env.example .env   # edit secrets before deploying
docker compose up -d
```

The app is served by Caddy on ports 80/443. The application itself listens on port 3000.

### Development

Start backend services (PostgreSQL + MinIO) with exposed ports:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up db storage
```

Then run the frontend locally:

```bash
npm install
npm run dev          # dev server at http://localhost:5173
```

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
