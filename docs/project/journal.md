# Project Journal

Concise remarks about: (1) the workflow, (2) readjustments to the workflow, and (3) the motivation behind those readjustments. Not what was built (git log) or why a technology was chosen (ADRs).

## 2026-04-06 — Iteration 4: deployment and post-session audit

### Workflow: long sessions need hard quality gates

The deployment session ran too long without checkpoints. Issues were closed with zero checklist boxes ticked, docs were written as command dumps, and the app was deployed over HTTP despite requiring HTTPS (Secure cookies, HSTS). Cleaned up in a follow-up session: branch squashed from 22 commits to 4, #42 reopened, docs rewritten, TLS enforcement tracked in #47, CD hardening in #48.

**Readjustment:** end-of-session audit is now mandatory before closing issues. Checklist boxes get ticked individually, not assumed done because "the code is there."

**Why:** output quality degrades silently over long sessions. The earlier structural refactor (same day) was high quality with focused scope. The deployment work drifted into "just ship it." The cost of the cleanup session was higher than pausing earlier would have been.

### Workflow: defense in depth is not negotiable

VPN encryption was treated as sufficient, skipping TLS. This left authentication broken and the API exposed over plain HTTP.

**Readjustment:** HTTPS is mandatory in every deployment, regardless of network layer. No assumptions about what sits in front of the app.

**Why:** one failing layer should never leave customer data unprotected.

## 2026-04-06 — Iteration 3: structural refactor

### Workflow: periodic structural audits as a hard gate

Multi-angle analysis (5 parallel agents: spec, backend, frontend, infra, coupling) found the architecture was sound but the implementation took shortcuts — duplicated logic, god objects, hardcoded types that the spec claimed were configurable. Decision: halt features and restructure. 77 files changed, tests 136 to 186.

**Readjustment:** structural audit before each complexity threshold, not after. Compare spec claims against actual code to catch drift early.

**Why:** AI-generated code optimizes locally — each feature lands cleanly in isolation, but cross-file coupling degrades silently. Invisible until you trace a change across the full call graph.

### Workflow: parallel agents need file-level isolation

6 agents launched simultaneously. Non-overlapping file groups landed cleanly. Agents touching files the orchestrator was also editing caused overwrites.

**Readjustment:** agents get exclusive file sets. No shared files between parallel agents or between agents and the orchestrator.

### Workflow: spec extensibility claims need smoke tests

"States driven by configuration" was false — the type was hardcoded. Spec promises without implementation tests are wishful thinking.

**Readjustment:** future iterations include "extensibility door" tests that verify the spec's promises compile and run.

## 2026-04-05 — Iteration 2: security foundation

### Workflow: security review is a distinct phase, not part of "code quality"

Implementation went fast — full stack in one session, 136 passing tests. Security review found 42 issues (6 critical). Deployment deferred; iteration rescoped to "secure foundation."

**Readjustment:** security review is a separate workflow step, not bundled under code quality. Non-negotiable before any deployment.

**Why:** AI-generated code systematically underweights security — no input validation, no security headers, hardcoded dev credentials without production guards. Tests pass, code looks professional, but the security posture is absent.

### Workflow: incremental implementation + review, not big-bang

One session built everything, another session reviewed everything. Result: 4 feat commits followed by 12+ fix commits.

**Readjustment:** smaller cycles — implement and review per module, not per iteration.

### Workflow: adversarial review scales

Parallel adversarial reviewers (5 domain-specific agents) followed by parallel fixers followed by a cross-cutting second wave. The pattern works but should happen incrementally, not as a final gate.

## 2026-04-03 — Iteration 0/1: bootstrap

### Workflow: parallel generation + adversarial review + synthesis

5 spec proposals evaluated against 8 criteria by independent agents. Best elements synthesized. Two rounds of adversarial review (9+10 agents). Established the core pattern.

### Workflow: parallel prototyping replaces speculation

5 tech stacks prototyped in parallel in isolated worktrees. Showed all to pilot company — validated information architecture before choosing a stack. Stack decision deferred to iteration 1, where empirical evidence could inform it (ADR-0002).

### UX insight: board structure IS the visibility mechanism

Action-column accumulation signals falling behind. Not per-card decoration.

## 2026-04-02 — Project bootstrap

Parallel agent teams for spec preparation (8 agents) and framework evaluation (6 agents). Open items tracked as GitHub Issues from day one.
