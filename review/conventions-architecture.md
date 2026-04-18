<!-- READ-ONLY for AI -->

# ARCHITECTURE.md Conventions

`ARCHITECTURE.md` lives at the project root. It serves as the navigation guide to the implementation — all main implementation concepts should be listed clearly and concisely, as a reference. The reader should be able to quickly gather an overview of the whole system and have a clear understanding of where to look to dive deeper into the code.

The specification contains the contract the app must fulfill. `ARCHITECTURE.md` contains an overview of how this contract is fulfilled, with references to the main modules for the concrete implementation.

[conventions-docs-general.md](conventions-docs-general.md) applies here as well.

Rules for ARCHITECTURE.md:

- **A-TRKI** — Fully adheres to the Kickoff document (ultimate source of truth). Kickoff outranks the spec because the spec is AI-written and may err.
- **A-TRUP** — Fully adheres to the prescriptions from the spec (upstream source of truth), except if this contradicts the Kickoff (needs to be flagged).
- **A-TRDO** — Corresponds to the reality of the implementation/code (downstream artifact).

Note: The described document is written by AI agents and may contain errors, inaccuracies and/or omissions.
