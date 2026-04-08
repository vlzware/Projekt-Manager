# Project Journal

Concise remarks about: (1) the workflow, (2) readjustments to the workflow, and (3) the motivation behind those readjustments. Not what was built (git log) or why a technology was chosen (ADRs).

## 2026-04-06 — Iteration 4: deployment and post-session audit

### Workflow: agent output needs verification before closing issues

The deployment session produced working infrastructure but the agent closed issues with zero checklist boxes ticked, wrote docs as command dumps, and deployed over HTTP despite the app requiring HTTPS. Follow-up audit caught it: branch squashed from 22 commits to 4, #42 reopened, docs rewritten, TLS enforcement tracked in #47, CD hardening in #48.

**Readjustment:** verify agent output against the issue checklist before closing. Tick boxes individually.

### Workflow: defense in depth is not negotiable

VPN encryption was treated as sufficient, skipping TLS. This left authentication broken and the API exposed over plain HTTP.

**Readjustment:** HTTPS is mandatory in every deployment, regardless of network layer. No assumptions about what sits in front of the app.

**Why:** one failing layer should never leave customer data unprotected.

## 2026-04-06 — Iteration 3: structural refactor

### Workflow: periodic structural audits as a hard gate

Multi-angle analysis (5 parallel agents) found the architecture was sound but the implementation had drifted — duplicated logic, god objects, hardcoded types the spec claimed were configurable. Decision: halt features and restructure.

**Readjustment:** structural audit before each complexity threshold. Compare spec claims against actual code to catch drift early.

**Why:** AI-generated code optimizes locally — each feature lands cleanly in isolation, but cross-file coupling degrades silently. Invisible until you trace a change across the full call graph.

### Workflow: spec extensibility claims need smoke tests

"States driven by configuration" was false — the type was hardcoded.

**Readjustment:** include "extensibility door" tests that verify the spec's promises compile and run.

## 2026-04-05 — Iteration 2: security foundation

### Workflow: make security review explicit in the workflow definition

Security reviews were run as soon as there was a baseline to review against. The review found 42 issues (6 critical), deployment deferred, iteration rescoped to "secure foundation." The reviews worked — but security wasn't listed as an explicit step in CONTRIBUTING.md.

**Readjustment:** add security review as a named workflow step so it's visible and not implicit.

**Why:** running reviews at the right time is not enough if the workflow definition doesn't reflect it. New contributors (or agents) following the written workflow would skip it.

### Workflow: adversarial review scales

Parallel adversarial reviewers (5 domain-specific agents) followed by parallel fixers followed by a cross-cutting second wave. The pattern works. Each iteration improves the codebase measurably — the squashed commit history reflects logical grouping, not big-bang development.

## 2026-04-03 — Iteration 0/1: bootstrap

### Workflow: parallel generation + adversarial review + synthesis

5 spec proposals evaluated against 8 criteria by independent agents. Best elements synthesized. Two rounds of adversarial review (9+10 agents). Established the core pattern.

### Workflow: parallel prototyping replaces speculation

5 tech stacks prototyped in parallel in isolated worktrees. Showed all to pilot company — validated information architecture before choosing a stack. Stack decision deferred to iteration 1, where empirical evidence could inform it (ADR-0002).

### UX insight: board structure IS the visibility mechanism

Action-column accumulation signals falling behind. Not per-card decoration.

## 2026-04-02 — Project bootstrap

Parallel agent teams for spec preparation (8 agents) and framework evaluation (6 agents). Open items tracked as GitHub Issues from day one.
