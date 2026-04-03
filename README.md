# Projekt-Manager

A centralized system for consolidation, control, and viewing of data and processes in small, German-speaking "Handwerker" (tradesman) companies.

## Status

**Iteration 1 — Walking Skeleton**: Front-end prototype with Kanban board, calendar view, and project detail panel. Tech stack decided ([ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md)): TypeScript + React 19 + Vite + Zustand.

## Prerequisites

- Node.js >= 22 (see `.nvmrc`)
- npm >= 10

## Quick Start

```bash
npm install
npm run dev          # dev server at http://localhost:5173
npm run build        # production build
npm test             # unit + component tests
npm run test:e2e     # Playwright E2E tests
```

First-time Playwright setup requires `npx playwright install` to download browser binaries.

## Documentation

- [Kickoff](docs/project/kickoff.md) — project definition, scope, goals, and boundaries
- [Plan](docs/project/plan.md) — development plan and iteration strategy
- [Architecture Decision Records](docs/adr/index.md) — documented project decisions
- [Walking Skeleton Spec](docs/iterations/0/spec.md) — what the prototype implements
- [Contributing conventions](CONTRIBUTING.md) — code style, workflow, branching, issues

## Project Structure

```
src/                Source code (React + TypeScript)
docs/
  project/          Foundational project documents (kickoff, plan, journal)
  adr/              Architecture Decision Records
  iterations/
    0/              Iteration 0 — setup, research, specifications
    1/              Iteration 1 — walking skeleton, hosting research
```

## License

TBD
