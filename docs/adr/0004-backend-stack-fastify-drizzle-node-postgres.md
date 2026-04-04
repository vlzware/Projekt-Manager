# ADR-0004: Backend stack — Fastify, Drizzle ORM, node-postgres

- **Status:** Accepted
- **Date:** 2026-04-04
- **Confidence:** High

## Context

ADR-0002 locked the frontend stack and established TypeScript as the project language. ADR-0003 established Docker Compose as the deployment layer with PostgreSQL as the database. The backend framework and database access layer remain open.

Key forces:

- **TypeScript end-to-end.** The backend must be TypeScript (architecture.md §11.1). The framework must have first-class TypeScript support, not bolted-on type definitions.
- **Lightweight for the scale.** The system serves 1–5 users with 10–30 concurrent projects. Enterprise scaffolding (dependency injection, decorators, module systems) adds ceremony without proportional benefit.
- **SQL-literate.** The spec requires versioned schema migrations and a repository-pattern storage layer. The ORM should make it easy to understand what queries run — debugging opaque query generation is a poor use of time.
- **Validation at the boundary.** The API layer validates all incoming requests (spec §API). Built-in schema validation reduces boilerplate and keeps validation co-located with route definitions.

## Decision

We will use **Fastify** as the HTTP framework, **Drizzle ORM** for database access and migrations, and **node-postgres (pg)** as the underlying PostgreSQL driver.

### Fastify

Fastify provides built-in request/response validation via JSON Schema, a plugin architecture for organizing the six responsibility layers, and TypeScript support without wrapper libraries. Its schema-based validation aligns with the spec's requirement that the API layer validates all incoming requests — schemas are declared alongside routes, not in a separate validation layer.

### Drizzle ORM

Drizzle defines the database schema in TypeScript and generates types directly from it — the same schema drives migrations, queries, and type checking. Its query API reads like SQL rather than abstracting it away, making it straightforward to reason about what the database executes. Migration files are plain SQL, versioned and reproducible as the spec requires.

### node-postgres

Drizzle uses node-postgres as its PostgreSQL driver. This is the most established PostgreSQL client for Node.js with no additional abstraction.

## Alternatives Considered

### Express

The most widely used Node.js framework. Mature ecosystem, extensive middleware. Ruled out because its TypeScript support relies on community-maintained `@types/express` rather than built-in types, and it lacks built-in request validation — requiring additional libraries (Joi, Zod, express-validator) that Fastify handles natively.

### Hono

Ultra-lightweight (~14 kB), excellent TypeScript support, runs on multiple runtimes (Node, Deno, Bun, edge). A strong candidate. Ruled out in favor of Fastify's more established ecosystem, richer plugin architecture, and built-in JSON Schema validation. Hono's multi-runtime portability is not a factor — ADR-0003 established Node.js in Docker as the runtime.

### NestJS

Enterprise-grade, Angular-inspired architecture with decorators, dependency injection, and module systems. Ruled out because this overhead is disproportionate for a system serving 1–5 users. The ceremony that benefits large teams becomes friction for a solo developer.

### tRPC

End-to-end type safety by sharing type definitions between client and server — no schema duplication. Ruled out because it couples the API shape to TypeScript clients. The API becomes untestable with standard HTTP tools (curl, Postman) and inaccessible to non-TypeScript consumers. The spec describes a REST API with standard HTTP semantics.

### Prisma

The most popular TypeScript ORM. Schema-first approach, auto-generated client, polished migration workflow. Ruled out because it ships a query engine binary (~15 MB) that runs as a sidecar process, adding resource overhead and cold-start latency. Its query abstraction is opaque — when a query behaves unexpectedly, diagnosing the generated SQL adds a debugging layer. Drizzle's SQL-literate API avoids this.

### Knex.js

Query builder with solid migration support. More control than a full ORM. Ruled out because it requires manual TypeScript type definitions for query results — Drizzle generates these from the schema automatically, eliminating a class of type drift bugs.

## Consequences

### Positive

- Type safety flows from database schema through queries to API responses — schema changes surface as compile errors
- Fastify's JSON Schema validation keeps request validation co-located with route definitions
- Drizzle migrations are plain SQL — inspectable, portable, no ORM lock-in for the migration history
- Both libraries are actively maintained with growing adoption and community support

### Negative

- Fastify's plugin system has a learning curve — lifecycle hooks and encapsulation contexts are not immediately intuitive
- Drizzle is younger than Prisma — less LLM training data and fewer community resources, which matters in an AI-assisted workflow (the same force that favored React over Svelte in ADR-0002). Mitigated by Drizzle's SQL-literate API: where LLM support falls short on niche Drizzle patterns, the developer can reason in SQL directly
- JSON Schema (Fastify's validation format) is more verbose than alternatives like Zod schemas

## References

- [ADR-0002: Tech Stack — TypeScript, React 19, Vite, Zustand](0002-tech-stack-typescript-react-vite-zustand.md)
- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [Architecture — Responsibility layers](../spec/architecture.md)
- [Product Spec](../spec/index.md)
