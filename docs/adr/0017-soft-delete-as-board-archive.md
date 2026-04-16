# ADR-0017: Project soft-delete as board archive, not audit trail

- **Status:** Accepted
- **Date:** 2026-04-13
- **Confidence:** High

## Context

The project data model includes a soft-delete mechanism (`projects.deleted = true`) that excludes projects from active views while retaining them in the database. The semantics of that flag — whether it represents an indelible audit record or a reversible archive — govern how related destructive operations (customer deletion, per-project hard-delete) must behave.

Three forces shape the decision:

1. **No regulatory or compliance requirement in scope** mandates immutable project records. This is a small-business tool, not a system of record for a regulated industry.
2. **The real use case for archiving is board hygiene.** A contractor completing many jobs per year accumulates a long vertical scroll in the `erledigt` Kanban column. Completed projects must move off the board while remaining queryable for reference (e.g., when a customer calls back about a job from last year).
3. **The real use case for hard-delete is data correction.** Typos, duplicate entries, test rows, and per-project privacy erasure must be possible without destroying an entire customer relationship.

The project lifecycle is: active workflow → terminal state (`erledigt`) → archived (off the board, still queryable) → optionally purged.

## Decision

Soft-delete is semantically **"archive from board"** — a reversible-in-principle mechanism for moving projects out of active views. It is not an audit trail and carries no immutability guarantee. Three destructive paths are defined, each with an explicit scope.

### 1. Archive (soft-delete)

The default "delete project" action. Sets `projects.deleted = true`, which removes the project from active views — Kanban board, default lists, exports. The management view exposes an `Archivierte einblenden` filter that re-includes archived rows. Archived projects remain tied to their customer.

There is intentionally **no UI action to unarchive/restore.** Restoration adds complexity without a real-world driver; the archive is a one-way move at the UI layer. The flag is mechanically reversible in the database, but that path is not exposed to end users.

### 2. Customer deletion cascade

Owner-only. `DELETE /api/customers/:id` behaves as follows:

- If the customer has any **active** (non-archived) projects, deletion is rejected with 409 Conflict.
- If the customer has only **archived** projects (or no projects at all), deletion succeeds and atomically purges all archived projects of that customer inside a single transaction.

`GET /api/customers/:id` returns `archivedProjectCount` so the UI can surface an explicit destruction warning before the owner confirms.

### 3. Per-project purge (hard delete)

Owner-only, gated by the permission `project:purge` and served by `DELETE /api/projects/:id/purge`. The endpoint enforces a **two-step trash-bin pattern**: a project must already be archived (`deleted = true`) before it can be purged. Attempting to purge a non-archived project returns 409 Conflict with a message directing the user to archive the project first.

In the UI, purge is surfaced as `Endgültig löschen` on archived rows in the management view, behind the `Archivierte einblenden` filter. Owner-only is deliberate: the gravity matches customer deletion — irreversible and no downstream recourse. `project_workers` rows cascade automatically via `ON DELETE CASCADE`; nothing else references `projects.id`.

The archive-first gate makes accidents expensive: a fat-finger must pass through two distinct, consciously different UI actions. It also makes `deleted = true` the canonical "trash bin" state on which purge operates.

## Alternatives Considered

### Audit-trail model (indelible soft-delete)

Treat soft-deleted projects as immutable records. Customer deletion remains blocked whenever any project — including archived — references the customer.

Rejected. No regulatory driver justifies the operational friction, and the FK-level block on customer deletion has no application-level recourse for a small-business tool.

### Remove soft-delete entirely — `erledigt` IS the archive

Drop the flag. Completed projects stay in the terminal Kanban column forever.

Rejected. The `erledigt` column would grow without bound; after years of operation the board becomes unusable.

### Cancelled/storniert workflow state

Introduce a state for abandoned-in-progress projects, distinct from completed work.

Orthogonal to this decision. It addresses a different concern (abandoned vs. completed) and can be added independently if the need surfaces.

### Single-step hard-delete (no archive-first gate)

Expose `DELETE /api/projects/:id/purge` without requiring prior archive.

Rejected. Archive is cheap and reversible in principle; hard-delete is final. A two-step gate is proportionate to the gravity and matches the trash-bin mental model users already understand from operating systems and mail clients.

### Reuse `customer:delete` for per-project purge

Serve purge under the existing customer-deletion permission rather than introducing `project:purge`.

Rejected. Purging a single project is a strictly narrower blast radius than deleting a customer and all their projects. A separate permission is right-sized and avoids over-granting.

## Consequences

### Positive

- Customer deletion works intuitively once all projects are archived — no invisible FK block.
- The Kanban board stays clean over years of use.
- Mis-created or privacy-sensitive single projects can be fully removed without destroying the customer relationship.
- No pretense of audit compliance that the system does not actually deliver.
- The archive remains queryable (management view filter, exports) until explicitly purged.

### Negative

- Purging a project permanently destroys that project's history (notes, assignments). Mitigated by the archive-first gate and an owner-only confirmation dialog.
- Deleting a customer permanently destroys all of that customer's archived project history. Mitigated by the UI warning showing `archivedProjectCount`.

## References

- [data-model.md §6.9](../spec/data-model.md) — soft-delete and purge specification.
- [verification.md](../spec/verification.md) — AC-61 (soft-delete marks project deleted), AC-79 (management view delete action performs soft-delete), AC-91 (customer delete atomically purges archived projects), AC-95 (mutations on soft-deleted projects rejected), plus the purge ACs covering the `project:purge` permission, the archive-first gate, and the `Endgültig löschen` UI path.
