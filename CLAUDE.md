# Projekt-Manager

## References
- **Repo**: vlzware/Projekt-Manager (private)
- **Project board**: https://github.com/users/vlzware/projects/2
- **Journal**: [docs/project/journal.md](docs/project/journal.md)
- **Open items**: GitHub Issues, prioritized on the project board

## Current Iteration
Current iteration scope and progress are tracked via GitHub Milestones.

**Framework decision (pending ADR)**: Vite + React 19 + TypeScript + Zustand + Tailwind + shadcn/ui + FullCalendar + dnd-kit + Vitest + Playwright.

## Workflow
Steps happen in this order. Skipping or reordering must be flagged.

1. Specification (clear, testable)
2. Tests (failing) — must cover the spec completely
3. Implementation
4. Tests passing
5. Code quality review (separate from correctness)
6. Documentation update
7. Commit
8. Retrospection → issues for the backlog

Detailed procedures for individual steps (agent orchestration, adversarial review, etc.) are defined in the corresponding skills.

## Undecided Specifics
Many details are deliberately left open until their iteration. When work hits something undefined:
1. Stop — do not assume.
2. Flag what is undefined and why it blocks.
3. When decided — suggest recording it as an ADR.
