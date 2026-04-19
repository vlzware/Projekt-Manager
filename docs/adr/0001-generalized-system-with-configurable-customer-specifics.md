# ADR-0001: Generalized system with configurable customer specifics

- **Status:** Accepted
- **Date:** 2026-04-02
- **Confidence:** High

## Context

The project was sparked by a specific "Handwerker" company, but the observed anti-patterns — no centralized data, ad-hoc tools, reactive workflows — are industry-wide. Using real company data in an open-source repo would also expose private business details.

## Decision

Build a generalized system with all customer-specific details configurable. The pilot company's specifics live in a separate, closed codebase that integrates with the general system. During development, reasonable assumptions stand in for real data.

## Alternatives Considered

### Build specifically for the pilot company

Simpler initially — no abstraction, no configuration. Rejected: limits the project to one customer, leaks private data into the repo, and a generalized approach fits a widespread problem.

### Build for the pilot first, generalize later

Defers the abstraction cost. Rejected: retrofitting configurability risks baking in single-customer assumptions that are painful to untangle.

## Consequences

### Positive

- Applicable to a wide range of similar small companies
- Pilot's private details stay out of the repo
- Each new customer is a configuration exercise, not a rewrite

### Negative

- Every design choice must consider configurability
- Some per-customer needs may demand architectural changes, not just config
- Slower initial development than a hardcoded single-customer build
- Development-time assumptions still need validation with the pilot company

## References

- [Kickoff.md — Target](../project/kickoff.md#target)
- [Kickoff.md — Company specifics](../project/kickoff.md#company-specifics)
