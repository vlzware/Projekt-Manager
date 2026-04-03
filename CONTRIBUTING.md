# Contributing

Conventions and workflows for this project. Applies to all contributors (human and AI).

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

Rules:
- One feature, one fix, or one refactor per commit
- Do not batch unrelated changes
- Amending is acceptable when justified (typo, forgotten file from same change)

## Issue Granularity

Issues are work items (not just bugs). Each issue should represent **one reviewable unit of work**.

- Too small: takes <30 minutes and is meaningless on its own — group it with related work
- Right size: a coherent change that can be understood and reviewed independently
- Too large: takes more than a couple of days — split it

**Types** are distinguished through labels, not naming conventions.

## Labels

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

Labels describe **type** and **status**. Scope (which iteration) is tracked via GitHub Milestones, not through labels.

## Iterations and Milestones

Each iteration maps to a GitHub Milestone. When creating an issue for the current iteration, assign it to the active milestone:

```
gh issue create --milestone "Iteration N" ...
```

Issues not tied to the current iteration stay in the backlog without a milestone. They can be pulled into a milestone later when capacity allows.

## Board Workflow

Kanban board columns: **Backlog** | **Ready** | **In Progress** | **Done**

| Transition | Trigger |
|------------|---------|
| Backlog → Ready | Issue is refined, has enough detail to start |
| Ready → In Progress | Work begins (manual) |
| In Progress → Done | Issue closed (automated) |

- **Closing an issue** = work is complete and merged into the iteration branch
- **Merging iteration branch to main** = iteration milestone (separate event, not per-issue)
- WIP limit: 1-2 items in progress at a time

## Definition of Done

Before declaring any task complete:

- [ ] Tests pass (new tests written if behavior changed)
- [ ] Documentation reflects reality
- [ ] No secrets committed, no debug leftovers
- [ ] Changes committed with a clear conventional commit message
- [ ] If skipping any item, call it out explicitly as tracked debt
