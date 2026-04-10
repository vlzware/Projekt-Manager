# ADR-0002: Tech Stack — TypeScript, React 19, Vite, Zustand

- **Status:** Accepted
- **Date:** 2026-04-03
- **Confidence:** High

## Context

The walking skeleton spec (iteration 0) deliberately left the tech stack open. During iteration 1, five parallel prototypes were built by independent agents in isolated worktrees, each implementing the full 26 acceptance criteria:

| Prototype | Stack                                              | Page weight | Source LOC | Build time |
| --------- | -------------------------------------------------- | ----------- | ---------- | ---------- |
| A         | React 19 + FullCalendar + shadcn/ui + Tailwind     | 257 kB      | 1,950      | 11.7 min   |
| B         | React 19 + Custom Calendar + Zustand + CSS Modules | 240 kB      | 2,306      | 11.7 min   |
| C         | Svelte 5 + Custom Calendar + Runes                 | 247 kB      | 2,603      | 15.2 min   |
| D         | Vue 3 + Pinia + Custom Calendar + CSS Modules      | 237 kB      | 2,557      | 15.6 min   |
| E         | PHP 8 + Vanilla JS + Sessions                      | 95 kB       | 2,498      | 14.7 min   |

Page weight measured via browser "Save As" (total resources). Build time is agent wall-clock time for the full spec. All page weights are well within acceptable range — this was not a differentiator.

Key forces:

- The project optimizes for **AI-assisted development** — LLM code quality and generation speed matter.
- **Type safety** is load-bearing as the codebase grows beyond a prototype.
- Deployment cost is not a constraint (free-tier Node.js hosting available).
- The developer has Angular/TypeScript experience but no framework preference.
- ADR-0001 requires all company-specific values to be configurable.

## Decision

**TypeScript + React 19 + Vite + Zustand + CSS Modules + date-fns**, tested with **Vitest + Playwright**.

This decision was made in three steps:

### 1. TypeScript over PHP

PHP produced the lightest page weight (95 kB) and simplest deployment model (shared hosting, no build step). However:

- PHP splits the codebase into two languages (PHP backend + vanilla JS frontend) with no type checking on the frontend.
- No component testing story for vanilla JS — only E2E tests can catch UI regressions.
- Free-tier Node.js hosting (Render, Koyeb) eliminates PHP's deployment cost advantage.
- TypeScript provides end-to-end type safety and a single language across domain logic, state, UI, and tests.
- LSP integration enables real-time error detection during AI-assisted development.

The project is expected to grow beyond a prototype. Type safety and a unified language outweigh PHP's simplicity advantages.

### 2. React over Vue and Svelte

All three TypeScript frameworks produced working prototypes. The differentiators:

- **LLM code generation quality**: React prototypes completed in 11.7 min each. Vue and Svelte took 15+ min for the same spec. React has the most LLM training data, producing faster and more accurate generation.
- **Vue 2/3 confusion**: LLM output frequently mixes Vue 2 Options API patterns with Vue 3 Composition API, requiring manual correction. This is a measurable friction in AI-assisted workflows.
- **Svelte 5 ecosystem maturity**: Youngest of the three. Some libraries still transitioning from Svelte 4 to 5. Least AI training data available.
- **Ecosystem size**: React's ecosystem means most problems have established, well-documented solutions.

Vue's Composition API is closest to the developer's Angular experience, but the project optimizes for AI-assisted development over manual coding comfort.

### 3. Custom components + CSS Modules over FullCalendar + Tailwind

Within React, Prototype A (FullCalendar + shadcn/ui + Tailwind) and Prototype B (custom calendar + CSS Modules) both completed the spec at the same speed (11.7 min).

Prototype B was chosen because:

- Custom calendar components give full control over the layout. The spec has specific display requirements that FullCalendar's API would constrain.
- CSS Modules provide scoped styling without additional dependencies — sufficient for this project's scope.
- Zustand (~1 kB) provides TypeScript-first state management with a minimal API.

## Alternatives Considered

### PHP 8 + Vanilla JS

Lightest output (95 kB), cheapest deployment, no build tooling. Rejected: no frontend type safety, split language, no component testing for vanilla JS.

### Vue 3 + Pinia

Clean Composition API, closest to Angular DX, official state management. Rejected: Vue 2/3 version confusion degrades LLM output quality, smaller ecosystem than React.

### Svelte 5

Smallest bundle, most elegant reactivity model (runes), high developer satisfaction. Rejected: youngest ecosystem, least LLM training data, library ecosystem still transitioning to v5.

### React + FullCalendar + shadcn/ui + Tailwind

Polished calendar out of the box, rich UI primitives via shadcn. Rejected: FullCalendar's API limits customization of the specific calendar layout the spec requires, additional dependencies without proportional benefit at this project's scale.

## Consequences

### Positive

- Type errors caught at edit time — fewer runtime surprises
- Fastest AI code generation of all evaluated stacks
- Largest third-party ecosystem as features grow
- Single language across the entire codebase
- Prototype B serves as a working reference implementation

### Negative

- React's hook model has known footguns (stale closures, dependency arrays, effect chains) — requires discipline
- "Choose your own adventure" ecosystem — more library decisions than Vue or Svelte's batteries-included approach
- CSS Modules lack the rapid prototyping speed of Tailwind utility classes

## References

- [ADR-0001: Generalized system with configurable customer specifics](0001-generalized-system-with-configurable-customer-specifics.md)
- Prototype comparison: detailed in the Context section above; prototyping process described in `docs/project/journal.md` (2026-04-03 entry)
- Product spec: `docs/spec/index.md`
