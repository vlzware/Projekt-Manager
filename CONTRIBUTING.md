# Contributing

Conventions for this project. Applies to all contributors (human and AI).

## Runtime Requirements

- Node.js >= 22 (see `.nvmrc`)
- npm >= 10

## Tech Stack

| Concern | Choice | Reference |
|---|---|---|
| Language | TypeScript (strict) | [ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md) |
| Framework | React 19 | |
| Build | Vite | |
| State | Zustand | |
| Styling | CSS Modules (`.module.css`) | |
| Date math | date-fns | |
| Unit/Component tests | Vitest + @testing-library/react | |
| E2E tests | Playwright | |

## Workflow

Steps happen in this order. Skipping or reordering must be flagged.

1. **Specification** — clear, testable acceptance criteria
2. **Tests (failing)** — must cover the spec completely
3. **Test-spec traceability review** — independent reviewer verifies every acceptance criterion maps to at least one test; gaps block step 4
4. **Implementation**
5. **Tests passing**
6. **Code quality review** — separate from correctness
7. **Documentation update**
8. **Commit**
9. **Retrospection** — issues for the backlog

### Test-spec traceability

Each test references the criterion it covers (e.g., `// AC-3: Projects in "Anfrage" appear in first column`). After tests are written, an independent reviewer:

1. Lists all acceptance criteria from the spec
2. Maps each to its test(s)
3. Flags unmapped criteria as gaps

Gaps block implementation (step 4). The reviewer must be different from the test author.

## Code Style

- **German UI, English code.** All variable names, functions, types, and comments in English. User-facing labels in German, centralized in config.
- **One component per file.** File name matches the default export.
- **CSS Modules.** One `.module.css` per component. No inline styles for layout, no global CSS except a minimal reset.
- **No `any`.** TypeScript strict mode. Use proper types or `unknown`.
- **Imports.** Absolute from `src/` root where the bundler supports it, relative within the same module.

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

**Types**: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `style`

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

| Label | Purpose |
|-------|---------|
| `bug` | Something isn't working |
| `feature` | New feature |
| `chore` | Build, tooling, config, refactoring |
| `documentation` | Improvements or additions to documentation |
| `spec` | Specification work |
| `research` | Needs investigation |
| `spike` | Timeboxed investigation |
| `decision` | Needs a decision |
| `adr` | Architecture Decision Record candidate |
| `blocked` | Waiting on something external |

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

| Document | Location | Answers | Contains | Does NOT contain |
|---|---|---|---|---|
| **Spec** | `docs/spec/` | "What does the system do?" | Current user-facing behavior, data model, acceptance criteria, edge cases | Architecture, component structure, implementation details |
| **Working files** | `docs/wip/` | Scratch space for the current iteration | Design notes, research, reference screenshots — anything ephemeral | Nothing that should outlive the iteration |
| **Design doc** | optional, per feature | "How do we build it?" | Architecture, APIs, data flow, component breakdown | Business requirements, acceptance criteria |
| **ADR** | `docs/adr/` | "Why this and not that?" | A single decision with rationale and alternatives | Implementation details, full designs |

### The framework-swap test

Specs are stack-agnostic. The litmus test: **if swapping the framework wouldn't change the statement, it belongs in the spec. If it would, it belongs in an ADR or design doc.**

### Iteration spec lifecycle

1. At the start of an iteration, update the spec files in `docs/spec/` to reflect the new scope. Git history preserves previous iterations.
2. Implement against the spec.
3. The spec always reflects the current state of the system.
