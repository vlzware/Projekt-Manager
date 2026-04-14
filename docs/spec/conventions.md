# Spec Conventions

Rules the [product specification](index.md) must satisfy. Used as a review rubric — every spec change is verified against this checklist before merge. IDs (`S-A1`, `S-B2`, …) let findings cite a rule directly.

## A. Coherence with the kickoff

- **S-A1** — The spec fully follows and extends the [kickoff](../project/kickoff.md). No discrepancy with the stated baseline (scope, "Not Doing", assumptions).

## B. Internal consistency

- **S-B1** — The spec is consistent with itself; no contradictions between files or sections.
- **S-B2** — Each rule is stated at one authoritative location. Other places cross-reference, not restate.

## C. Completeness

- **S-C1** — The spec is logically complete. Every observable behavior has a defined trigger, outcome, and boundary condition.
- **S-C2** — Error paths are defined. For every mutation, the spec states what happens when it fails, conflicts, or is unauthorized.

## D. Style — tech-agnostic

- **S-D1** — The spec strives to be tech-agnostic. Test: if swapping TypeScript / React / Fastify would change the statement, it belongs in an [ADR](../adr/index.md). **TypeScript snippets are explicitly permitted to avoid pseudo-code** and are not violations on their own — only flag a snippet if the statement it makes would not survive a stack swap.

## E. Style — no noise

- **S-E1** — The spec leaves minute implementation details to the implementers.
- **S-E2** — Each statement is as short as possible without losing logic.
- **S-E3** — The spec is a contract for the code. It contains no historical references, iteration mentions, roadmap notes, or plans.

## F. Self-containment

- **S-F1** — External references are limited to project-internal documentation under `docs/` and the root files [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`ARCHITECTURE.md`](../../ARCHITECTURE.md). References to transient content (iteration notes, journal entries, files in `docs/wip/`) are not acceptable.
- **S-F2** — All references work — no dead links, no references to moved or removed sections.

## G. Acceptance criteria

- **S-G1** — Every AC carries exactly one tier marker: `[crit]`, `[vis]`, or `[infra]`. Definitions live in the [verification.md AC legend](verification.md#15-acceptance-criteria).
- **S-G2** — Each AC describes observable behavior at a system boundary (UI, API, DB constraint) — not an implementation invariant.
- **S-G3** — Each AC is testable, not vague.

## H. Configurability

- **S-H1** — Every value deliberately made configurable carries `[C]` and appears in the `[C]` catalogue ([architecture.md §12.2](architecture.md#122-company-configurable-settings)).

## I. Traceability

- **S-I1** — Every AC appears in [docs/testing/traceability.md](../testing/traceability.md).
- **S-I2** — Every traceability entry still maps to an AC in the spec.

---

## Out of scope for this checklist

- **Code-vs-spec drift** (silent extensions, behavior the spec does not describe) — code-side concern, audited separately.
- **Implementation quality** — covered by code review and CI gates, not this rubric.
