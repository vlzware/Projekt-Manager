# Project Journal

Captures workflow decisions, scope shifts, and learnings — not what was built (that's git log) or why a technology was chosen (that's ADRs).

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
