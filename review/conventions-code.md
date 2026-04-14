# Code Conventions

Rules for the code:

- **C-DATA** — Data integrity, data loss, stale data — **CRITICAL**.
- **C-ARCH** — Adherence to the specification and `ARCHITECTURE.md` at the project's root.
- **C-EXTE** — No "silent extensions" — behavior the spec does not describe.
- **C-SRES** — Single responsibility.
- **C-DRYY** — DRY.
- **C-SIZE** — File size.
- **C-NAME** — Naming of variables, functions, files, etc. is clear.
- **C-INPU** — Input validation at system boundaries (API, DB, file I/O); trust internals.
- **C-HARD** — No magic strings/numbers — named constants or enums.
- **C-DEAD** — No dead code — commented-out blocks, unreachable branches.
- **C-SECU** — Authorization checked before sensitive data is accessed.

Note: All code in the project is written by AI agents and may contain errors, inaccuracies and/or omissions.
