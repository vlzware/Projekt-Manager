# ADR-0014: AC tier system — critical, design, and infra coverage

- **Status:** Accepted
- **Date:** 2026-04-12 (original); updated 2026-04-15 (see [Updates](#updates))
- **Confidence:** High

## Context

By iteration 5, the project had accumulated ~4,700 LOC of component and UI tests that mocked APIs and rendered components in jsdom. Three problems compounded:

1. **False confidence.** Mock-based UI tests passed against mocked APIs while the real app failed. LLM agents routinely excused failures with "the app is not running" — the mocks were the test, not the application. A test suite that passes when the product is broken is worse than no tests: it provides false assurance.

2. **Perverse incentives from coverage targets.** A numeric coverage goal steered test authorship toward the cheapest lines to cover, not the most valuable behavior to verify. The result was high coverage numbers with low defect-detection value.

3. **Unmaintainable volume.** Every UI atom had a dedicated test file. Sixteen component test files, three orphaned test helpers, and hundreds of assertions that broke on any refactor — regardless of whether behavior changed. The maintenance cost exceeded the verification value.

## Decision

We will classify every acceptance criterion into one of three tiers based on defect impact, and verify each tier with the test strategy that matches its risk profile.

**Classification test:**

> If this breaks, does the user lose data, money, access, or act on wrong information?
> **Yes → `[crit]`** — unit and/or integration test against the real stack.
> **No → `[vis]`** — an E2E test drives the scenario; the visual judgment is a human review via `npx playwright test --ui`.
>
> Orthogonal to the user-facing impact question: constraints on the deployed environment, the build pipeline, or the source-tree organization (CI gates, deployment procedures, lint-enforced layering, repo-scan checks) carry the `[infra]` tier and are verified by their respective automation — not by tests against the running system.

**Applied to the current spec:** every AC in [verification.md §15](../spec/verification.md#15-acceptance-criteria) carries exactly one of `[crit]`, `[vis]`, or `[infra]`. The mapping from AC to verification artifact lives in [traceability.md](../testing/traceability.md); an empty cell there is a gap, not a default.

**Concrete changes:**

- Removed 16 mock-based component/UI test files and 3 orphaned helpers (−3,789 LOC).
- Added an E2E flow suite (`management-flows`, `kanban-flows`, `permission-visibility`, `failure-paths`, `theming`, `theme-preference`, `import-export-flows`, …) that drives every `[vis]` scenario. The suite runs headless as the automated behavioral gate; the visual judgment is the human reviewer's, performed in UI mode.
- Removed jsdom from vitest; unit project runs in node environment only.
- No coverage target. The traceability matrix (`docs/testing/traceability.md`) is the single measure of "is everything covered?" — every AC maps to its verification artifact.
- Added `scripts/check-traceability.sh` lint step to detect drift between spec, matrix, and test files.

## Alternatives Considered

### Keep mock-based tests and add E2E on top

Main advantage: no test deletion, additive change. Ruled out because it doubles the maintenance surface without fixing the core problem — the mock-based tests still test mocks, not the app. Two test suites that overlap on the same ACs with different fidelity levels means both need updating on every change, and disagreements between them are ambiguous.

### E2E only — no unit or integration tests

Main advantage: maximum simplicity, every test exercises the real stack. Ruled out because E2E tests are too slow and too coarse for critical-path verification. Domain logic (state transitions, auth rules, constraint enforcement) needs isolated, fast, deterministic tests that pinpoint the defect. An E2E failure on a transition rule requires debugging through the full stack; a unit test failure points at the line.

### Coverage target with exclusions

Main advantage: keeps a numeric gate. Ruled out because the incentive structure is the same — the metric optimizes for covered lines, not for defect detection. Adding exclusion lists just makes the target more complex to maintain without changing what it rewards.

## Consequences

### Positive

- Net −4,051 LOC of test code. Lower maintenance burden, fewer false failures on refactors.
- Higher confidence per test. Unit/integration tests hit the real stack (Fastify + PostgreSQL), not mocks. E2E tests render the real app in a real browser against real infrastructure.
- Clear ownership: every AC has exactly one verification strategy. No ambiguity about which test suite is responsible.
- The classification test is a one-sentence decision rule that two people apply consistently.

### Negative

- `[vis]`-tier verification depends on a human running Playwright UI mode and judging by eye. This is slower than a pixel-diff assertion, but the stored-screenshot path was tried and failed (see [Updates](#updates)).
- Every `[vis]` AC must have an E2E that drives the scenario, even when no `expect()` asserts on the rendered result. Without the test, the reviewer has nothing to watch — clicking through the UI manually scenario by scenario is not scalable. An uncovered `[vis]` AC is a gap in the matrix, not a "design-only, no test needed" exemption.
- The traceability matrix is now load-bearing. If it drifts, coverage gaps go undetected. Mitigated by the lint script, but the script is advisory (warnings, not errors) until confidence in the workflow matures.

## Updates

### 2026-04-14 — screenshot baselines dropped

Stored Playwright screenshot baselines (`visual-regression*.spec.ts` and the associated `-snapshots/` directories) were removed in commits cf6f63d and 9577fdf. They were net-negative in this project: legitimate UI tweaks produced a constant stream of false positives, which trained contributors to blind-update the baselines — defeating the signal the suite was meant to provide. The original ADR framed `[vis]` verification as "E2E visual regression (Playwright screenshot diff)"; the mechanism is now "E2E test drives the scenario; human review via `npx playwright test --ui`". The classification rule and the tier's defect-impact semantics are unchanged.

The functional E2E specs (`management-flows`, `kanban-flows`, `permission-visibility`, …) remain the automated behavioral gate and are exactly the scripts the reviewer time-travels through in UI mode. Trace retention flipped to `retain-on-failure` so a failed local or CI run always produces a reviewable trace without needing a retry to trigger.

### 2026-04-15 — `[infra]` promoted to a first-class tier label

The original ADR treated infrastructure/structural ACs as "untiered". Every AC in [verification.md §15](../spec/verification.md#15-acceptance-criteria) now carries exactly one of `[crit]`, `[vis]`, or `[infra]`. This closes the "what tier is this?" ambiguity flagged in review (conventions-spec rule `S-ACS1`) and makes the "no tests against the running system" expectation explicit for deployment, lint, and repo-scan constraints.

## References

- [CONTRIBUTING.md § Acceptance Criteria](../../CONTRIBUTING.md#acceptance-criteria): tier definitions and classification test
- [CONTRIBUTING.md § Testing](../../CONTRIBUTING.md#testing): UI-mode workflow for `[vis]` review
- [docs/testing/traceability.md](../testing/traceability.md): the traceability matrix
- [docs/spec/verification.md §15](../spec/verification.md#15-acceptance-criteria): tiered AC list
