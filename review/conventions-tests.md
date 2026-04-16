<!-- READ-ONLY for AI -->

# Test Conventions

Issues to watch for:

- **T-TAUT** — Tautology: test tests nothing.
- **T-REDU** — Redundancy: test duplicates another test's coverage.
- **T-BLOA** — Bloat: test tests some minute, non-critical details of the implementation, which are not covered by the AC it belongs to. See "reasonable assumptions" in the Kickoff and "minute details" in the spec.
- **T-ACBS** — Miss: test does not really test what it claims to test

Note: All tests in the project are written by AI agents and may contain errors, inaccuracies and/or omissions.
