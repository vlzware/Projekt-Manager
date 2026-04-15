# ADR-0018: Data persistence and recovery — layered strategy

- **Status:** Accepted
- **Date:** 2026-04-15
- **Confidence:** High

## Context

The kickoff commits to automated database backup (line 72) but declares "a backup concept and system beyond that" out of scope (line 80). Iteration 7 forces the open question: what "backup" actually means here, and how it relates to the test-seeding path that currently bypasses the API.

Three classes of data live in the system with different properties:

1. **Business data** — customers, projects, assignments, archive state. Structured, small, strict-schema, portable as text.
2. **Full database state** — everything SQL persists, including users, sessions. Byte-exact. The disaster-recovery anchor.
3. **Binary attachments** — photos, Aufmaß, uploads. Large, opaque. Durability is a storage-layer property.

Further constraints:

- **"Data loss is inevitable"** — a backup that is never restored is not a backup. Restore must be continuously verified.
- **No backwards-compatibility work** — shims, format migrations, and deprecated wrappers are technical debt.
- **VPN-first threat model** (ADR-0008) — accidents and misconfiguration dominate; targeted attack is out of scope.
- **R2 as planned binary store** (#45) — not yet integrated; this decision must not assume it.
- **Existing per-entity bulk endpoints** — partial, ad-hoc, overlapping with the goals here.

## Decision

We will treat data persistence and recovery as **three independent layers**, each with its own scope, tooling, and restore-verification strategy:

| Layer                         | Captures                                        | Trigger                                 | Restore                                                          | Verification                                                          |
| ----------------------------- | ----------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Business data (app-level)** | Customers, projects, assignments, archived rows | Human via UI (`data:export` permission) | Unified import endpoint (`data:restore`), restore-only semantics | CI roundtrip: seed → export → wipe → import → export → byte-compare   |
| **Full DB state**             | Everything in PostgreSQL                        | Scheduled `pg_dump` on the VPS          | `pg_restore`                                                     | Scheduled job restores into ephemeral DB, asserts schema + row counts |
| **Binary attachments**        | Uploaded files                                  | Continuous, storage-provider-owned      | Provider restore mechanics                                       | Provider durability SLA + documented deployment requirements          |

For the business-data layer specifically:

- **Single unified endpoint** (`GET /api/export`, `POST /api/import`) — the per-entity endpoints are removed.
- **Restore-only** import semantics: empty target → proceed; non-empty target → refuse unless an explicit override flag is set (to keep dev ergonomic). IDs are preserved. All-or-nothing single transaction.
- **Strict schema versioning**: export writes a monotonic `schema_version` integer; import rejects any mismatch. **No data-format migration code.** If production ever forces a cross-version import, it is handled at that moment by a one-off script.
- **Dry-run mode** on import: full validation and preview, no writes.
- **Users excluded** from the business-data export. Admin bootstrap (ADR-0010) handles user creation on fresh installs. Test seeding uses a direct-DB helper confined to the test layer.

The three layers are **complementary, not substitutes**. App-level export is not disaster recovery (it omits users, sessions, schema state). `pg_dump` is not portability (encodes postgres internals). Binary durability belongs to the storage layer.

## Alternatives Considered

### A single unified backup system

One tool producing one artifact capturing everything. Advantage: one restore command. Ruled out: conflates three incompatible data shapes (size, portability, schema stability) and matches precisely what the kickoff declares out of scope. Also forces invented solutions for problems already handled by existing tools (`pg_dump`, object-storage versioning).

### `pg_dump` as the only strategy

Rely on the full DB dump for all recovery, drop the app-level export. Advantage: one path, byte-exact. Ruled out: no portability between installations, no human-readable test fixture, and leaves the "test data must exercise the API" concern (#90) unaddressed.

### App-level export as the only strategy

Export everything the app sees (including users and session analogues) and reconstruct from it. Advantage: portable and human-readable. Ruled out: cannot capture schema, indices, sequence state, or anything outside domain entities; it is portability, not disaster recovery.

### Per-entity endpoints kept alongside unified

Keep `/api/export/projects`, `/api/export/customers`, and their bulk imports, and layer the unified endpoint on top. Advantage: no deletion, preserves a speculative "migration from external systems" path. Ruled out: foreign-system adapters are kickoff-out-of-scope, and two shapes (enriched DTO vs. row-fidelity unified) multiply surface area without a concrete beneficiary. Consistent with the no-backwards-compatibility rule.

### App-level data-format migrations

Versioned export with translation code bridging old formats to current. Advantage: historical exports remain ingestible. Ruled out: speculative complexity for a pre-production project with no historical exports that matter. Strict-version rejection preserves the option to write a one-off script if production ever demands it.

## Consequences

### Positive

- Each layer uses the right tool for its data shape — no invented machinery.
- Restore is continuously verified at the app-level via a CI roundtrip test; the test-seed path and the backup path become the same path, exercised on every build.
- Strict schema versioning plus no migration code keeps maintenance surface near zero.
- Restore-only semantics make atomicity trivial and eliminate the merge/conflict design space.
- Business-data portability becomes a first-class, documented capability (new installations, local dev reset, fixture-driven tests) without claiming to be disaster recovery.
- `seed.ts` aligns with the application layer, closing the long-standing gap where tests bypassed validation.

### Negative

- Three independent layers mean three independent operational stories. A fresh-install operator must understand which layer handles what.
- DB dump kept on the same VPS is a single-site risk — offsite replication is the deployment operator's responsibility, not the system's.
- Restore-only cannot update a live dataset in place. Partial-data-update flows remain the responsibility of the normal CRUD API; deliberate.
- Removing the per-entity endpoints is a breaking change on paper. The project has no consumers so the impact is zero, but the diff is large.
- Binary-layer durability depends on a storage provider (R2 per #45) not yet integrated. Until integrated, the binary layer is aspirational; the decision stands but its implementation is gated on that work.

## References

- [Kickoff](../project/kickoff.md) — line 72 (automated DB backup as goal), line 80 (backup-system expansion as non-goal)
- [ADR-0008](0008-vpn-first-network-access.md) — VPN-first threat model
- [ADR-0010](0010-first-run-admin-bootstrap.md) — how users are created on fresh installs (why users are excluded from business-data export)
- [ADR-0017](0017-soft-delete-as-board-archive.md) — archived rows are business data and must round-trip
- Issue [#90](https://github.com/vlzware/Projekt-Manager/issues/90) — seed.ts replacement and the "export all" open question
- Issue [#46](https://github.com/vlzware/Projekt-Manager/issues/46) — DB-level backup + monitoring (second-layer tracker)
- Issue [#45](https://github.com/vlzware/Projekt-Manager/issues/45) — R2 / object storage integration (third-layer tracker)
- Issue [#105](https://github.com/vlzware/Projekt-Manager/issues/105) — role-scoped views; this ADR commits to `data:export` and introduces `data:restore`
