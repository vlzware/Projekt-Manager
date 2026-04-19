# ADR-0002: Tech Stack — TypeScript, React 19, Vite, Zustand

- **Status:** Accepted
- **Date:** 2026-04-03
- **Confidence:** High

## Context

The walking skeleton spec (iteration 0) deliberately left the tech stack open. In iteration 1, five parallel prototypes were built by independent agents in isolated worktrees, each implementing the full 26 acceptance criteria:

| Prototype | Stack                                              | Page weight | Source LOC | Build time |
| --------- | -------------------------------------------------- | ----------- | ---------- | ---------- |
| A         | React 19 + FullCalendar + shadcn/ui + Tailwind     | 257 kB      | 1,950      | 11.7 min   |
| B         | React 19 + Custom Calendar + Zustand + CSS Modules | 240 kB      | 2,306      | 11.7 min   |
| C         | Svelte 5 + Custom Calendar + Runes                 | 247 kB      | 2,603      | 15.2 min   |
| D         | Vue 3 + Pinia + Custom Calendar + CSS Modules      | 237 kB      | 2,557      | 15.6 min   |
| E         | PHP 8 + Vanilla JS + Sessions                      | 95 kB       | 2,498      | 14.7 min   |

Page weight (total resources via browser "Save As") was within acceptable range for all — not a differentiator. Build time is agent wall-clock for the full spec.

Key forces:

- The project optimizes for **AI-assisted development** — LLM code quality and generation speed matter.
- **Type safety** is load-bearing as the codebase grows beyond a prototype.
- Deployment cost is not a constraint (free-tier Node.js hosting available).
- Developer has Angular/TypeScript experience, no framework preference.
- ADR-0001 requires all company-specific values to be configurable.

## Decision

**TypeScript + React 19 + Vite + Zustand + CSS Modules + date-fns**, tested with **Vitest + Playwright**.

Decided in three steps:

### 1. TypeScript over PHP

PHP produced the lightest output (95 kB) and simplest deployment (shared hosting, no build step). But it splits the codebase into two languages with no frontend type checking, has no component testing story for vanilla JS, and free-tier Node.js hosting (Render, Koyeb) nullifies the deployment-cost edge. TypeScript gives end-to-end type safety, LSP-driven edit-time feedback, and a single language across domain, state, UI, and tests.

### 2. React over Vue and Svelte

All three TypeScript prototypes worked. Differentiators:

- **LLM code generation quality**: React prototypes finished in 11.7 min; Vue and Svelte took 15+ min for the same spec.
- **Vue 2/3 confusion**: LLM output frequently mixes Options and Composition APIs — measurable friction.
- **Svelte 5 ecosystem**: youngest of the three, libraries still transitioning from v4, least LLM training data.
- **Ecosystem size**: React has the most established, well-documented solutions.

Vue's Composition API is closest to the developer's Angular experience, but the project optimizes for AI-assisted development over manual coding comfort.

### 3. Custom components + CSS Modules over FullCalendar + Tailwind

Within React, Prototypes A and B both finished in 11.7 min. B was chosen because:

- Custom calendar components give full control — the spec has specific layout requirements FullCalendar's API would constrain.
- CSS Modules provide scoped styling with no extra dependency.
- Zustand (~1 kB) is TypeScript-first with a minimal API.

## Alternatives Considered

_Details in Decision above; one-line rejections here._

- **PHP 8 + Vanilla JS** — no frontend type safety, split language, no component testing for vanilla JS.
- **Vue 3 + Pinia** — Vue 2/3 version confusion degrades LLM output; smaller ecosystem.
- **Svelte 5** — youngest ecosystem, least LLM training data, libraries still on v4→v5.
- **React + FullCalendar + shadcn/ui + Tailwind** — FullCalendar constrains the required calendar layout; extra deps without proportional benefit at this scale.

## Consequences

### Positive

- Type errors caught at edit time
- Fastest AI code generation of all evaluated stacks
- Largest third-party ecosystem as features grow
- Single language across the codebase
- Prototype B serves as a working reference implementation

### Negative

- React hooks have known footguns (stale closures, dependency arrays, effect chains) — requires discipline
- "Choose your own adventure" ecosystem — more library decisions than Vue or Svelte
- CSS Modules lack Tailwind's rapid-prototyping speed

## References

- [ADR-0001: Generalized system with configurable customer specifics](0001-generalized-system-with-configurable-customer-specifics.md)
- Prototype comparison detailed in the Context section above
- Product spec: `docs/spec/index.md`
