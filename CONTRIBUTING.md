<!-- READ-ONLY for AI -->

# Contributing

For lists of category-specific conventions (spec, docs, code, tests, ARCHITECTURE.md) see review/conventions-\*.md

## Runtime Requirements

- Node.js (pinned in `.nvmrc` — use `nvm install`)
- npm (use the version bundled with that Node release — do not upgrade independently)

## Tech Stack

See [ARCHITECTURE.md § Tech Stack](ARCHITECTURE.md#tech-stack).

## Workflow

Steps happen in this order. Skipping or reordering must be flagged.

1. **Specification** — see review/conventions-spec.md
2. **Tests (failing)** — see review/conventions-tests.md
3. **Tests review** — independent reviewer verifies for adherence to review/conventions-tests.md. Violations are blocking, back to step 2.
4. **Implementation** — see review/conventions-code.md
5. **Tests passing**
6. **Code quality review** — independent reviewer verifies for adherence to review/conventions-code.md. Violations are blocking, back to step 4.
7. **Security audit** (conditional) — needs to be confirmed by user. Propose it when trust boundaries change
8. **Documentation update** — see review/conventions-docs-general.md
9. **Commit** — group changes, including multiple files, in logical groups
10. **Open Issues** — list all open issues, including findings discovered during the workflow, even if unrelated

### Security audit

The trigger question: **"Does this change affect how the system authenticates, authorizes, stores data, communicates externally, or exposes itself to the network?"** If yes — propose an audit. If no — skip.

## Testing

| Layer              | Command                                     |
| ------------------ | ------------------------------------------- |
| Unit + integration | `npm run test`                              |
| E2E headless       | `npm run test:e2e`                          |
| E2E interactive    | `npx playwright test --ui --project=<name>` |
| Trace review       | `npx playwright show-trace <zip>`           |

**Design ACs** The functional E2E specs (`management-flows`, `kanban-flows`, `permission-visibility`, …) remain the automated behavioral gate.

**UI Mode gotcha**: pass `--project=<name>` explicitly — `chromium` for read-only specs (including `permission-visibility`), `chromium-mutating` for serial tests that mutate DB state, `smoke` for the unauthenticated boot check. Without an explicit project, the filter defaults hide everything but the `setup` login and the test tree appears empty.

**Integration prerequisites**: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db storage storage-init` — `npm run test` needs Postgres on `:5432` and MinIO on `:9000`; Playwright needs those plus the dev server on `:5173` (auto-started via `webServer`). Close the MCP Chromium browser or limit workers before Playwright runs — the persistent MCP instance plus per-worker Playwright browsers OOM Chrome.

## Code Style

- **German UI, English code.** All variable names, functions, types, and comments in English. User-facing labels in German, centralized in config.
- **One component per file.** File name matches the default export.
- **CSS Modules.** One `.module.css` per component. No inline styles for layout, no global CSS except a minimal reset.
- **No `any`.** TypeScript strict mode. Use proper types or `unknown`.
- **Imports.** Absolute from `src/` root where the bundler supports it, relative within the same module.
- **Quality gates are enforced by two git hooks plus CI.**
  - **pre-commit** (`.husky/pre-commit`)
  - **pre-push** (`.husky/pre-push`)
  - **CI** (`ci.yml`)

## Branching Strategy

```
main                          always reflects completed iterations
  └── iteration/N-name        integration branch for iteration N
       ├── 12-state-model     feature branch (issue #12)
       └── 15-adr-framework   feature branch (issue #15)
```

- **main**: Only receives merges from completed iteration branches. Never commit directly.
- **Iteration branch**: Integration target during an iteration. Feature branches (optional, make on request) merge here via PR.

## Commit Conventions

[Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>: <short description>

[optional body]
```

**Types**:

`feat`, `fix`, `refactor`, `test`, `docs`, `chore`

One logical change per commit. Don't batch unrelated changes. Batch related changes.
