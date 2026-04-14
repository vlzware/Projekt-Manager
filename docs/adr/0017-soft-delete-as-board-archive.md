# ADR-0017: Project soft-delete as board archive, not audit trail

- **Status:** Accepted
- **Date:** 2026-04-13
- **Confidence:** High

## Context

The project data model includes a soft-delete mechanism (`deleted = true`) that excludes projects from active views while retaining them in the database. This was originally motivated by an "audit trail" rationale — the assumption that all records must be preserved indefinitely for compliance or historical accountability.

A data integrity audit surfaced several problems with this framing:

1. **Soft-deleted projects block customer deletion.** The FK on `projects.customerId` has `ON DELETE NO ACTION`. When a user soft-deletes all projects for a customer, then tries to delete the customer, the FK rejects it — even though no visible projects reference that customer. The user has no application-level recourse.
2. **No regulatory requirement exists.** The project has no compliance obligation that mandates immutable record retention.
3. **The real use case is board hygiene.** A painting contractor completing 50 jobs per year accumulates a long vertical scroll in the `erledigt` Kanban column. The user needs to move completed projects off the board while keeping them queryable for reference (e.g., a customer calls back about a job from last year).

The project lifecycle is: active workflow → terminal state (`erledigt`) → archived (off the board) → purged (when customer relationship ends).

## Decision

We will treat soft-delete as **"archive from board"** — a practical mechanism for moving completed projects out of active views while retaining them as historical reference. This is not an audit trail and carries no immutability guarantee.

Consequences for customer deletion:

- **Active (non-archived) projects** still block customer deletion (409 Conflict) — this is the existing and correct behavior.
- **Archived projects** are purged atomically with the customer. The archive has no value without the customer relationship. The API returns `archivedProjectCount` on `GET /api/customers/:id` so the UI can show an explicit warning before this destructive action.

## Alternatives Considered

### Keep the audit-trail model

Treat soft-deleted projects as immutable records. Customer deletion remains blocked when any project (including archived) references the customer. Recovery from the "invisible FK block" requires manual SQL.

Ruled out because no regulatory requirement justifies the operational friction, and the "admin runs SQL" escape hatch is error-prone for a small-business tool.

### Remove soft-delete entirely — terminal state IS the archive

Make `erledigt` the only archive mechanism. No separate archive action; completed projects stay in the last Kanban column forever.

Ruled out because the `erledigt` column would grow unboundedly. After years of operation, the Kanban board becomes unusable — analogous to a GitHub project board where the "Done" column is never cleaned up.

### Add a "cancelled/storniert" workflow state instead

Introduce a new state for abandoned-in-progress projects, separate from the archive.

Not ruled out — but orthogonal to this decision. A cancelled state addresses a different concern (abandoned work vs. completed work). It can be added independently if the need arises.

## Consequences

### Positive

- Customer deletion works intuitively: if all projects are archived, the customer can be removed.
- The Kanban board stays clean over years of operation.
- No pretense of audit compliance that the system cannot actually deliver.
- The archive remains useful (queryable in the management view, included in exports) until the customer is deleted.

### Negative

- Deleting a customer permanently destroys their archived project history. This is an intentional and irreversible data loss — mitigated by the UI confirmation warning.
- The "archive" concept is currently surfaced only as soft-delete. A future iteration should rename the UI action from "Löschen" to "Archivieren" and add an "include archived" filter to the management view. Tracked separately.

## References

- Data integrity audit (this session) — identified the invisible FK block and the lifecycle gap.
- [data-model.md §6.9](../spec/data-model.md) — current soft-delete specification (to be updated).
- [AC-61](../spec/verification.md) — "Soft-deleting a project marks it as deleted."
- [AC-91](../spec/verification.md) — "Deleting a customer with no associated projects succeeds."
