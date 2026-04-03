# ADR-0001: Generalized system with configurable customer specifics

- **Status:** Accepted
- **Date:** 2026-04-02
- **Confidence:** High

## Context

The spark for this project came from a specific "Handwerker" company, but the anti-patterns observed — no centralized data, ad-hoc tools, reactive workflows — are widespread in the industry. We need to decide whether to build specifically for the pilot company or to build a generalized system.

Additionally, using real company data in the open-source repository would expose private business details.

## Decision

We will build a generalized system where all customer-specific details are configurable. The pilot company's specifics will live in a separate, closed codebase that integrates with the general system. Where customer details are needed during development, reasonable assumptions will be made instead of using real data.

## Alternatives Considered

### Build specifically for the pilot company

Simpler and faster initially — no abstraction layer needed, no configuration system. Ruled out because it limits the project to a single customer, exposes private company data in the repository, and the observed problems are common enough that a generalized approach has significantly more value.

### Build for the pilot first, refactor to configurable later

Defer the generalization cost. Ruled out because retrofitting configurability is harder than building it in from the start — it risks baking in assumptions that are painful to untangle later.

## Consequences

### Positive

- The system is applicable to a wide range of similar small companies
- Private details of the pilot company are protected
- The open-source repository contains no real customer data
- Each new customer integration is a configuration exercise, not a rewrite

### Negative

- Increased complexity: every design choice must consider configurability
- In some cases, per-customer needs may require architectural changes, not just configuration
- Slower initial development compared to a hardcoded single-customer build
- Assumptions made during development may not match real-world needs — validation with the pilot company remains necessary

## References

- [Kickoff.md — Target](../project/kickoff.md#target)
- [Kickoff.md — Company specifics](../project/kickoff.md#company-specifics)
