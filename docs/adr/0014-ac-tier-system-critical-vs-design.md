# ADR-0014: AC tier system — critical vs design test coverage

- **Status:** Accepted
- **Date:** 2026-04-12
- **Confidence:** High

## Context

By iteration 5, the project had accumulated ~4,700 LOC of component and UI tests that mocked APIs and rendered components in jsdom. Three problems compounded:

1. **False confidence.** Mock-based UI tests passed against mocked APIs while the real app failed. LLM agents routinely excused failures with "the app is not running" — the mocks were the test, not the application. A test suite that passes when the product is broken is worse than no tests: it provides false assurance.

2. **Perverse incentives from coverage targets.** A numeric coverage goal steered test authorship toward the cheapest lines to cover, not the most valuable behavior to verify. The result was high coverage numbers with low defect-detection value.

3. **Unmaintainable volume.** Every UI atom had a dedicated test file. Sixteen component test files, three orphaned test helpers, and hundreds of assertions that broke on any refactor — regardless of whether behavior changed. The maintenance cost exceeded the verification value.

## Decision

We will classify every acceptance criterion into one of two tiers based on defect impact, and verify each tier with the test strategy that matches its risk profile.

**Classification test:**

> If this breaks, does the user lose data, money, access, or act on wrong information?
> **Yes → `[crit]`** — unit and/or integration test against the real stack.
> **No → `[vis]`** — E2E visual regression (Playwright screenshot diff).

ACs that are structural or infrastructure constraints (CI gates, deployment procedures) are untiered and verified by their respective automation.

**Applied to the current spec (90 ACs):** 38 `[crit]`, 38 `[vis]`, 14 structural/infra.

**Concrete changes:**

- Removed 16 mock-based component/UI test files and 3 orphaned helpers (−3,789 LOC).
- Added 4 Playwright visual regression spec files with 42 screenshot tests (+612 LOC).
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
- Higher confidence per test. Unit/integration tests hit the real stack (Fastify + PostgreSQL), not mocks. Visual regression tests render the real app in a real browser.
- Clear ownership: every AC has exactly one verification strategy. No ambiguity about which test suite is responsible.
- The classification test is a one-sentence decision rule that two people apply consistently.

### Negative

- Screenshot baselines require maintenance on intentional visual changes. Accepted tradeoff — the alternative (mock-based component assertions) had worse maintenance characteristics for lower fidelity.
- The traceability matrix is now load-bearing. If it drifts, coverage gaps go undetected. Mitigated by the lint script, but the script is advisory (warnings, not errors) until confidence in the workflow matures.
- `[vis]`-tier ACs that describe interactions (e.g., "click collapsed column to expand") are verified by screenshots that capture state, not transitions. The E2E flow specs cover the interaction paths, but the traceability mapping must ensure interaction ACs point to flow steps, not just screenshots.

## References

- [CONTRIBUTING.md § Acceptance Criteria](../../CONTRIBUTING.md#acceptance-criteria): tier definitions and classification test
- [docs/testing/traceability.md](../testing/traceability.md): the traceability matrix
- [docs/spec/verification.md §15](../spec/verification.md#15-acceptance-criteria): tiered AC list
