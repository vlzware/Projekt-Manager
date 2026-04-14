# ARCHITECTURE.md Conventions

`ARCHITECTURE.md` lives at the project root. It serves as the navigation guide to the implementation — all main implementation concepts should be listed clearly and concisely, as a reference. The reader should be able to quickly gather an overview of the whole system and have a clear understanding of where to look to dive deeper into the code.

The specification contains the contract the app must fulfill. `ARCHITECTURE.md` contains an overview of how this contract is fulfilled, with references to the main modules for the concrete implementation.

Rules for ARCHITECTURE.md:

- **A-TRUP** — Fully adheres to the prescriptions from the spec (upstream source of truth).
- **A-TRKI** — As the spec is also written by AI agents and may contain errors, fully adheres to the Kickoff document (ultimate source of truth).
- **A-TRDO** — Corresponds to the reality of the implementation/code (downstream artifact).
- **A-BLRE** — No repetitions.
- **A-BLPR** — Short and concise — for each statement/paragraph: can this be shorter without losing logic?
- **A-BLDI** — Where possible, a simple diagram is worth more than a whole paragraph of prose.

Note: The described document is written by AI agents and may contain errors, inaccuracies and/or omissions.
