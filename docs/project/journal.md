# Project Journal

Captures workflow decisions, scope shifts, and learnings — not what was built (that's git log) or why a technology was chosen (that's ADRs).

## 2026-04-06 — Structural refactor: maintainability overhaul

### Trigger: code quality analysis exposed compounding debt

Deep multi-angle analysis (5 parallel agents: spec, backend, frontend, infra, coupling) revealed a consistent pattern: the *architecture design* (spec, ADRs, six-layer model) was solid, but the *implementation* took shortcuts. New features required touching too many files, and logic was duplicated rather than shared. The Zustand store was a 406-line god object mixing 5 concerns. Backend routes called repositories directly with no service layer. Fetch logic was copy-pasted 3x with identical session-expiry boilerplate. The spec claimed config-driven extensibility but WorkflowState was a hardcoded string union.

Left unchecked, every future feature would deepen the mess. Decision: halt all feature work and restructure.

### What changed (77 files, +4557/-1727 lines; code-only excl. tests/docs: +2089/-908)

Backend: centralized config, Zod env validation, service layer (AuthService + ProjectService), repository split into 3 focused files, test file split from 1x629-line file into 5. Frontend: extracted API client eliminating 3x fetch duplication, split monolithic store into auth/project/ui slices, extracted shared transition hook, added React Router for URL-based navigation. Testing: +10 permission enforcement tests, +27 repository unit tests, shared DB setup helper fixing intermittent seed race. Docs: ARCHITECTURE.md as onboarding entry point, spec security checklist, known debt index, iteration scope mapping. Features: bulk import endpoint, DB indexes.

Test count: 136 → 186 across 23 files. Net code expansion — structural refactoring (splitting god objects, adding layers) adds imports, exports, and file scaffolding. The payoff is in maintainability, not line count.

### Key learning: AI-generated code accumulates structural debt silently

The agents that built iterations 1-2 produced code that worked and passed tests, but optimized locally — each feature was implemented in the most direct way without regard for how the next feature would interact. No agent spontaneously introduced a service layer, split a growing store, or flagged that copy-pasting fetch boilerplate 3 times was a pattern worth abstracting. The code looked clean file-by-file but the *connections between files* degraded steadily. This is invisible until you trace a feature change across the full call graph.

Takeaway: periodic structural audits are essential in AI-assisted development — not as a nice-to-have, but as a hard gate before the codebase crosses a complexity threshold. The cost of this refactor was one session. Doing it two iterations later would have been a rewrite.

### Workflow: parallel agents with file-level isolation work, shared-file agents don't

Launched up to 6 agents simultaneously for non-overlapping file groups. Agents that touched independent files (ARCHITECTURE.md, spec docs, DB indexes, permission tests) landed cleanly. Agents that touched files already modified in the main thread (store.ts, component files) caused overwrites requiring manual reconciliation. Rule for future: agents get isolated file sets, never files the orchestrator is actively editing.

### Spec-implementation gap as a quality signal

The most actionable finding was comparing spec extensibility claims against actual code. "States driven by configuration" was false — the type was hardcoded. "Views consume the shared state layer independently" was technically true but the hardcoded ViewMode union and ternary in App.tsx made adding a view a 3-file surgery. Spec claims without corresponding implementation tests are wishful thinking. Future iterations should include "extensibility door" smoke tests that verify the spec's promises.

## 2026-04-05 — Iteration 2 retrospective

### Scope shift: deployment deferred

Iteration 2 was scoped as "Deployment and Data." Implementation went fast — one session on 04-04 produced a running full stack with 136 passing tests. Security review on 04-05 found 42 issues (6 critical). Deployment was deferred; the iteration became "build the secure foundation." The right call — the 04-04 codebase would have been an attractive-looking liability.

### Key learning: LLM security blind spots

LLM-generated code passes tests and looks professional, but has systematic security blind spots. It optimizes for "make it work" and underweights "make it safe" — no input validation, no security headers, no CSRF thinking, hardcoded dev credentials with no production guard. A security review before any deployment is non-negotiable in this workflow.

### Workflow: big-bang implementation → big-bang review doesn't scale

The entire backend, auth, storage, Docker, and CI/CD were built in one session, then reviewed in one session. Result: 4 `feat` commits followed by 12+ `fix` commits. Smaller implementation + review cycles (per-module) would catch issues earlier with less rework. The CONTRIBUTING.md workflow (spec → tests → implementation → review) doesn't account for security as a distinct concern — it's bundled under "code quality review," which proved insufficient.

### Workflow: adversarial review pattern scales

The adversarial review pattern from iteration 1 scaled to the security domain. 5 parallel reviewers (auth/sessions, API/injection, Docker/infra, frontend/XSS, storage/dependencies) → 6 agents fixing non-overlapping file groups → second wave for cross-cutting changes. The pattern works, but needs to happen incrementally, not as a final gate.

### Presentation skipped — no visible change for non-technical users

The backend, auth, storage, and security work is invisible to non-technical users. The Kanban board looks identical to the walking skeleton from iteration 1. The only visible difference would be a real URL instead of localhost — but deployment was deferred. Presenting an identical-looking app wouldn't serve the grounding purpose. Stakes are much higher now that the app is heading toward production — the quality and security grind is where the real time goes.

### Workflow adjustments still in flux

Constantly adjusting the LLM-assisted workflow: how to orchestrate agents, when to review, what to parallelize. This is expected for a new process, but the churn suggests the workflow needs to stabilize before iteration 3. Key open question: at what granularity should the implement→review cycle operate?

## 2026-04-03 — Iteration 0/1 workflow decisions

### Spec evaluation process

5 spec proposals from different LLMs evaluated against 8 criteria using independent adversarial agents. Best elements synthesized into the final spec. Two rounds of adversarial review (9+10 agents). This established the pattern: parallel generation → adversarial review → synthesis.

### Parallel prototyping as a decision method

5 tech stacks prototyped in parallel by independent agents in isolated worktrees. Empirical evaluation replaced speculation. Showed all prototypes to pilot company ("excited") — validated information architecture before choosing a stack. The method worked well; the only risk is that prototypes can look "done" when they're not.

### UX principle correction

Board structure IS the visibility mechanism — action-column accumulation signals falling behind. Not per-card decoration. This was a fundamental correction to how the Kanban semantics work.

### Stack decision deferred correctly

Stack decision deferred from iteration 0 to iteration 1, where parallel prototyping could inform it empirically. Decision rationale recorded in ADR-0002.

## 2026-04-02 — Project bootstrap workflow

Multi-agent teams for spec preparation (8 agents) and framework evaluation (6 agents). Established the pattern of parallel agent teams for exploratory work. Open items tracked as GitHub Issues from day one.
