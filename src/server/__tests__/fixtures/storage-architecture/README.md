# Storage architecture detector — negative-case fixtures

Files in this directory exist solely to exercise
`storage-architecture-detector.ts` against bypass shapes the prior
regex-based scanner missed (ADR-0022).

Each `*.fixture.ts` is INTENTIONALLY DESTRUCTIVE-LOOKING. Do not import
them from production code. The detector's production glob excludes
`__tests__/`, so these files are not flagged by the real architecture
sweep — they are loaded explicitly by the unit-test plumbing in
`storage-architecture.test.ts`.

If you add a new fixture, add a sibling test case asserting what the
detector should do with it. Fixtures without an assertion are dead
code — the test, not the fixture, is the load-bearing artifact.
