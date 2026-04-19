# ADR-0021: Audit log and notifications — single write path, publisher-over-audit

- **Status:** Accepted
- **Date:** 2026-04-19
- **Confidence:** High

## Context

Iteration 8 introduces two new mutation surfaces: file uploads (#108) and notifications (#112). The kickoff also commits to a configurable notification system ([line 64](../project/kickoff.md)) and an administrator view of user activity (line 67). The current codebase has no unified audit trail — entities carry ad-hoc `createdBy`/`updatedBy` fields, and every service method writes its own state change with no append-only record.

Forces:

- **New mutation sites arrive this iteration.** Retrofitting audit later is more expensive than routing new paths through a helper from day one.
- **LLM-assisted development saturates reviewer attention.** Code review alone is not a reliable guard against a raw write slipping through.
- **Notifications need an event source.** Double-writing audit-worthy events at every service-layer site is the drift risk the helper is meant to prevent.
- **No regulatory driver.** Value is debugging, dispute resolution, and the product-level "who did what when" view for privileged users — not compliance.
- **Rebuild-over-forensics posture.** Runtime guards earn their complexity only if their catch-rate outweighs the ongoing cost.

## Decision

We will route every domain-entity mutation through a single transactional `mutate()` service-layer helper that writes an audit row atomically with the state change. Notifications are a projection over the audit stream via a lightweight in-process publisher. Bypass is prevented at PR time by a CI-enforced architecture test. We do not add a runtime DB trigger.

Shape:

- **`audit_log` table**, append-only: `id`, `created_at`, `actor_id` (nullable FK to `user_accounts`), `actor_kind` (`user` | `system`), `actor_reason` (free text; required when `actor_kind = 'system'`), `entity_type`, `entity_id`, `action`, `payload` (jsonb: before/after of changed fields only, not full row), `correlation_id` (Fastify request id where available). Audited entity types: `project`, `customer`, `user`, `project_worker`. Authentication and session events are security events, not domain audit — they surface in the structured logger, not in `audit_log`.
- **`mutate()` helper** in the service layer: opens a transaction, executes the mutation, writes the audit row, commits. Every service method that changes state routes through it. The helper returns the committed audit row so subscribers dispatch after commit, never inside the transaction — a throwing subscriber cannot roll back domain state. Correlation id is threaded as a typed argument through the service call chain; services never import Fastify.
- **Architecture test**, CI-enforced: static scan fails on raw `INSERT/UPDATE/DELETE` or Drizzle `db.insert/update/delete` targeting audited tables outside the helper. Migrations, the `ImportService` restore path, and business seed loaders are allowlisted — bulk restore and fixture hydration do not generate audit rows.
- **Notification publisher**: in-process dispatch on commit. Subscription rules map `{entity_type, action}` pairs to templates and recipients. Non-mutation events (backup status, cron completion) publish to the same bus, bypassing audit.
- **User-facing audit view**: read-only endpoint and UI, RBAC-sliced via the same repository predicates as [ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md). Workers see human-readable activity for projects they're assigned to; PM/admin see actor names and a payload drawer; owner sees destructive events (purge, role change) others don't.
- **Retention**: aligned with the DB-backup window (90 days per [ADR-0020 Amendment 2026-04-19](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#amendments)). Revisit if the UI expectation is longer.

## Alternatives Considered

### Runtime DB trigger belt

`BEFORE INSERT/UPDATE/DELETE` trigger on audited tables rejecting any mutation without a paired audit row in the same transaction. Strongest at-rest guard — catches bypass regardless of write path. Ruled out: operational cost is ongoing and diffuse (migration bypass with `SET LOCAL`, fixture-loading complexity, seed friction, schema-change mental tax), while catch-rate value is narrow given a small team, code review, and the architecture test covering the common case. The rebuild-over-forensics posture tips this: a missed audit row is debugging-annoying, not catastrophic. Revisit if a compliance driver materializes.

### Two independent systems — audit and notifications each written directly by services

Each service method writes to `audit_log` and separately publishes a notification. Ruled out: this is the double-write the helper was introduced to prevent. Drift between the two surfaces is not _if_ but _when_.

### Unified `events` table serving both

One append-only stream; audit and notification views sit on top. Ruled out: shape mismatch (audit wants field-level diffs; notifications want rendered message data) and retention mismatch (audit long, notification short) overload a single schema. Publisher-over-audit keeps the shapes separate while preserving one write path.

### LISTEN/NOTIFY for cross-process dispatch

PostgreSQL pub/sub for the publisher instead of in-process. Ruled out now: single-process Fastify makes in-process sufficient. Revisit on multi-worker deployment.

### Full-row audit payloads

Store the complete new (and optionally previous) row rather than a changed-fields diff. Simpler to produce. Ruled out: storage growth is unbounded for wide entities, and the diff is what human viewers and notification rules actually consume.

## Consequences

### Positive

- Single write path — no drift between audit state and entity state.
- Notifications consume a ready-made event stream; new rules don't require touching every mutation site.
- User-facing activity view falls out of the same table with RBAC layered at the repository level.
- Architecture test catches bypass at PR time; zero runtime cost.
- Changed-fields payload keeps the table small compared to full-row snapshots.
- Domain-entity scope keeps the activity feed high-signal — login and session-reaper traffic does not drown project transitions and photo uploads.

### Negative

- Architecture test is static — won't catch dynamically constructed SQL or ORM escape hatches. The trigger belt would have; the cost analysis accepts this gap.
- In-process publisher is not durable across restarts. Acceptable at current scale (single Fastify process). Outbox pattern is the future migration if durability matters.
- `mutate()` needs the "before" state for update payloads — adds a read on update paths that didn't have one.
- Retention couples audit, notification history, and user-facing activity visibility — needs a conscious operator call if UI expectation extends beyond 90 days.
- Architecture-test allowlist is a trust surface — each bulk-mutation path added to it (restore, seed) must be reviewed in PR for the bypass it creates.
- **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — new persistent log of user actions, new cross-cutting helper. Scope: the helper surface and the audit table's access controls.

## References

- [Kickoff](../project/kickoff.md) — line 64 (configurable notifications), line 67 (admin activity view)
- [ADR-0017](0017-soft-delete-as-board-archive.md) — soft-delete is _not_ an audit trail; this ADR fills that gap
- [ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md) — RBAC predicate reused for the audit view
- [ADR-0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) — retention window the audit table aligns to
- [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — trigger satisfied
- Issue #116 — audit log infrastructure
- Issue #112 — notifications
- Issue #108 — file uploads (new mutation surface)
