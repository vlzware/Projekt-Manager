# Contributing

Conventions for this project. Applies to all contributors (human and AI).

## Runtime Requirements

- Node.js (pinned in `.nvmrc` — use `nvm install`)
- npm (use the version bundled with that Node release — do not upgrade independently)

## Tech Stack

See [ARCHITECTURE.md § Tech Stack](ARCHITECTURE.md#tech-stack).

## Workflow

Steps happen in this order. Skipping or reordering must be flagged.

1. **Specification** — clear, testable acceptance criteria
2. **Tests (failing)** — must cover the spec completely
3. **Test-spec traceability review** — independent reviewer verifies every acceptance criterion maps to at least one test; gaps block step 4
4. **Implementation**
5. **Tests passing**
6. **Code quality review** — separate from correctness
7. **Security audit** (conditional) — required when trust boundaries change
8. **Documentation update**
9. **Commit**
10. **Retrospection** — issues for the backlog

### Test-spec traceability

Each test references the criterion it covers (e.g., `// AC-3: Projects in "Anfrage" appear in first column`). After tests are written, an independent reviewer:

1. Lists all acceptance criteria from the spec
2. Classifies each as **critical** or **design** (see § Acceptance Criteria)
3. Maps critical ACs to their unit/integration test(s)
4. Maps design ACs to their visual regression screenshot(s)
5. Flags unmapped criteria as gaps

Gaps in critical ACs block implementation (step 4). The reviewer must be different from the test author. The maintained map lives in [docs/testing/traceability.md](docs/testing/traceability.md).

### Security audit

Required when a change affects trust boundaries. The trigger question: **"Does this change affect how the system authenticates, authorizes, stores data, communicates externally, or exposes itself to the network?"** If yes — audit. If no — skip.

Triggers include:

- Auth or session logic
- New or changed API endpoints with authorization
- Infrastructure changes (Docker, Compose, CI/CD, reverse proxy)
- External integrations (object storage, database schema)
- Deployment configuration

Does NOT trigger for: UI styling, refactoring, test changes, documentation, domain logic that doesn't touch boundaries.

The audit uses adversarial framing — reviewers with a security-specific lens, separate from the code quality review in step 6. Automated checks (`npm audit`, dependency scanning) run in CI on every push and complement but do not replace the manual audit.

## Acceptance Criteria

Not every AC warrants a unit or integration test. ACs are classified into two tiers based on what they guard:

### Critical AC

Guards a critical path — a defect here means data corruption, financial impact, authentication/authorization failure, data integrity violation, or misleading state that causes wrong user decisions.

- **Verified by:** unit and/or integration test
- **Traceability:** must appear in the test-spec traceability map with a test reference
- **Examples:** "Deleting a project requires confirmation and is irreversible", "Only authenticated users can access the API", "A failed mutation reverts the optimistic UI update"

### Design AC

Specifies expected behavior that does not guard a critical path — layout, interaction flow, status display, sorting, visual state.

- **Verified by:** human visual review via `npx playwright test --ui` (see [§ Testing](#testing))
- **Traceability:** tracked in spec; no stored baseline — the test exists, the judgment is the reviewer's
- **Examples:** "Projects in 'Anfrage' appear in the first column", "The export button is disabled when no projects are selected"

### Classification test

> **If this breaks, does the user lose data, money, access, or act on wrong information?**
> Yes → Critical AC → unit/integration test.
> No → Design AC → human visual review in Playwright UI mode.

## Testing

| Layer              | Command                                     | When                                                                                                                   |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Unit + integration | `npm run test`                              | Every change under `src/`. Critical ACs assert here.                                                                   |
| E2E headless       | `npm run test:e2e`                          | Before committing E2E work; full regression gate when Playwright is dispatched in CI.                                  |
| E2E interactive    | `npx playwright test --ui --project=<name>` | Design AC review; debugging a failing E2E. Time-travel through every step with DOM, network, and console side-by-side. |
| Trace review       | `npx playwright show-trace <zip>`           | Post-hoc inspection of a failed run — traces are retained on failure per `playwright.config.ts`.                       |

**Design ACs** are verified by running UI mode, watching the flow, and judging by eye. Stored-screenshot baselines were dropped: legitimate UI changes produced a stream of false positives that trained contributors to blind-update snapshots, defeating the purpose. The functional E2E specs (`management-flows`, `kanban-flows`, `permission-visibility`, …) remain the automated behavioral gate.

**UI Mode gotcha**: pass `--project=<name>` explicitly — `chromium` for read-only specs (including `permission-visibility`), `chromium-mutating` for serial tests that mutate DB state, `smoke` for the unauthenticated boot check. Without an explicit project, the filter defaults hide everything but the `setup` login and the test tree appears empty.

**Integration prerequisites**: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db storage storage-init` — `npm run test` needs Postgres on `:5432` and MinIO on `:9000`; Playwright needs those plus the dev server on `:5173` (auto-started via `webServer`). Close the MCP Chromium browser before Playwright runs on the 24 GB VM — the persistent MCP instance plus per-worker Playwright browsers OOM Chrome.

## Code Style

- **German UI, English code.** All variable names, functions, types, and comments in English. User-facing labels in German, centralized in config.
- **One component per file.** File name matches the default export.
- **CSS Modules.** One `.module.css` per component. No inline styles for layout, no global CSS except a minimal reset.
- **No `any`.** TypeScript strict mode. Use proper types or `unknown`.
- **Imports.** Absolute from `src/` root where the bundler supports it, relative within the same module.
- **Formatting is enforced by two git hooks, not just one.**
  - **pre-commit** (`.husky/pre-commit`): `husky` + `lint-staged` run `prettier --write` on staged files — both `src/**/*.{ts,tsx,css}` source files and `**/*.md` documentation. The hook installs on `npm install` via the `prepare` script — no extra setup. Files are auto-formatted and re-staged before the commit is recorded.
  - **pre-push** (`.husky/pre-push`): runs `npm run format:check` across the whole repo as a belt-and-braces gate. This catches the cases where a commit lands changes that lint-staged did not rewrite (e.g., a file added via `git add -p` that bypassed the staged-file watcher, or a hand-edited commit via `git commit --amend --no-verify`). If pre-push fails, run `npm run format` and amend/recommit before retrying the push.
  - **CI** (`ci.yml`, step `Format check`) runs the same `npm run format:check` — three layers of defense, all running the identical command.
  - To bypass in an emergency: `git commit --no-verify` skips pre-commit, `git push --no-verify` skips pre-push. CI's `format:check` will still catch the drift at PR time. Avoid using either flag outside a genuine emergency — the hooks are there because format drift blocks merges under the pre-push gate.

## Branching Strategy

```
main                          always reflects completed iterations
  └── iteration/N-name        integration branch for iteration N
       ├── 12-state-model     feature branch (issue #12)
       └── 15-adr-framework   feature branch (issue #15)
```

- **main**: Only receives merges from completed iteration branches. Never commit directly.
- **Iteration branch**: Integration target during an iteration. Feature branches merge here via PR.
- **Feature branches**: One branch per issue. Named `<issue-number>-<short-description>`. Branch off the current iteration branch.

## Commit Conventions

[Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>: <short description>

[optional body]
```

**Types**:

| Type       | Use for                                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat`     | A new user-visible feature or capability                                                                                                                                                                               |
| `fix`      | A bug fix in existing behavior                                                                                                                                                                                         |
| `refactor` | Restructuring existing code without changing behavior                                                                                                                                                                  |
| `test`     | Adding or improving tests                                                                                                                                                                                              |
| `docs`     | Documentation only — no code changes                                                                                                                                                                                   |
| `style`    | Formatting, whitespace, missing semicolons — no logic changes                                                                                                                                                          |
| `chore`    | Routine maintenance, tooling, dependency bumps — nothing user-visible and nothing deliberate about production readiness                                                                                                |
| `ci`       | CI configuration files and scripts (`.github/workflows/**`, lint/format/type-check wiring in the build)                                                                                                                |
| `ops`      | Operational readiness — deployment, infrastructure, runbooks, incident response. Use when the change is deliberate infra work that isn't routine maintenance (`chore`) and doesn't add a user-visible feature (`feat`) |

One logical change per commit. Don't batch unrelated changes.

## Issues

Issues are work items (not just bugs). Each issue represents **one reviewable unit of work**.

- Too small: <30 minutes and meaningless on its own — group with related work
- Right size: a coherent change that can be understood and reviewed independently
- Too large: more than a couple of days — split it

Types are distinguished through labels, not naming conventions.

### Dependencies

GitHub Issues has no native blocking mechanism. Use issue number references in the description:

```
Blocked by #18.
Blocked by #19 and #20.
```

This makes dependencies clickable and machine-readable. Don't describe the blocker in prose — the linked issue already has the context.

### Labels

| Label           | Purpose                                    |
| --------------- | ------------------------------------------ |
| `bug`           | Something isn't working                    |
| `feature`       | New feature                                |
| `chore`         | Build, tooling, config, refactoring        |
| `documentation` | Improvements or additions to documentation |
| `spec`          | Specification work                         |
| `research`      | Needs investigation                        |
| `spike`         | Timeboxed investigation                    |
| `decision`      | Needs a decision                           |
| `adr`           | Architecture Decision Record candidate     |
| `blocked`       | Waiting on something external              |

Labels describe **type** and **status**. Scope is tracked via GitHub Milestones.

## Iterations and Milestones

Each iteration maps to a GitHub Milestone — the single source of truth for what belongs in an iteration.

1. Create milestone at iteration start
2. Assign issues to the milestone as work is scoped
3. Create iteration branch `iteration/N-name` off `main`
4. Work — feature branches merge into the iteration branch via PR
5. Close milestone when all issues are resolved and iteration branch merges to `main`

Issues without a milestone stay in the backlog.

## Specification vs Design

| Document          | Location              | Answers                                 | Contains                                                                  | Does NOT contain                                          |
| ----------------- | --------------------- | --------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Spec**          | `docs/spec/`          | "What does the system do?"              | Current user-facing behavior, data model, acceptance criteria, edge cases | Architecture, component structure, implementation details |
| **Working files** | `docs/wip/`           | Scratch space for the current iteration | Design notes, research, reference screenshots — anything ephemeral        | Nothing that should outlive the iteration                 |
| **Design doc**    | optional, per feature | "How do we build it?"                   | Architecture, APIs, data flow, component breakdown                        | Business requirements, acceptance criteria                |
| **ADR**           | `docs/adr/`           | "Why this and not that?"                | A single decision with rationale and alternatives                         | Implementation details, full designs                      |

### The framework-swap test

Specs are stack-agnostic. The litmus test: **if swapping the framework wouldn't change the statement, it belongs in the spec. If it would, it belongs in an ADR or design doc.**

### Spec quality rules

Every spec change is reviewed against the rubric in [review/conventions-spec.md](review/conventions-spec.md) — coherence with the kickoff, internal consistency, completeness, no-noise style, self-containment, AC rigor, configurability marking, and traceability. Findings are cited by rule ID (`S-KICK`, `S-CONS`, …). The framework-swap test above is rule `S-TECH`.

### Iteration spec lifecycle

1. At the start of an iteration, update the spec files in `docs/spec/` to reflect the new scope. Git history preserves previous iterations.
2. Implement against the spec.
3. The spec always reflects the current state of the system.
