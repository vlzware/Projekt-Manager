# Spec Conventions

Rules the [product specification](../docs/spec/index.md) must satisfy. Used as a review rubric — every spec change is verified against this checklist before merge. IDs let findings cite a rule directly.

- **S-KICK** — The spec fully follows and extends the [kickoff](../docs/project/kickoff.md). No discrepancy with the stated baseline (scope, "Not Doing", assumptions).
- **S-CONS** — The spec is consistent with itself; no contradictions between files or sections.
- **S-SSOT** — Each rule is stated at one authoritative location. Other places cross-reference, not restate.
- **S-COMP** — The spec is logically complete. Every observable behavior has a defined trigger, outcome, and boundary condition.
- **S-ERRP** — Error paths are defined. For every mutation, the spec states what happens when it fails, conflicts, or is unauthorized.
- **S-TECH** — The spec strives to be tech-agnostic. Test: if swapping TypeScript / React / Fastify would change the statement, it belongs in an [ADR](../docs/adr/index.md). **TypeScript snippets are explicitly permitted to avoid pseudo-code** and are not violations on their own — only flag a snippet if the statement it makes would not survive a stack swap.
- **S-NDET** — The spec leaves minute implementation details to the implementers.
- **S-NBLO** — Each statement is as short as possible without losing logic.
- **S-NLOG** — The spec is a contract for the code. It contains no historical references, iteration mentions, roadmap notes, or plans.
- **S-REFS** — The spec can stand on its own — only acceptable external references are [kickoff](../docs/project/kickoff.md), [ADRs](../docs/adr/index.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`ARCHITECTURE.md`](../ARCHITECTURE.md). References must work — no dead links, no references to moved or removed sections.
- **S-ACS1** — Every AC carries exactly one tier marker as defined in the [verification.md AC legend](../docs/spec/verification.md).
- **S-ACS2** — Each AC is testable, not vague.
- **S-CONF** — Every configurable value — carrying `[C]` — appears in the `[C]` catalogue ([architecture.md "Company Configurable Settings"](../docs/spec/architecture.md)).
- **S-ACTR** — Every AC appears in [docs/testing/traceability.md](../docs/testing/traceability.md).
- **S-TRAC** — Every traceability entry still maps to an AC in the spec.

Note: The specification documents are all written by AI agents and may contain errors, inaccuracies and/or omissions.
