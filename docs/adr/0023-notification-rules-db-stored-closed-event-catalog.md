# ADR-0023: Notification rules as DB-stored configuration with a closed event catalog

- **Status:** Accepted
- **Date:** 2026-04-20
- **Confidence:** High

## Context

[Kickoff §Done when](../project/kickoff.md#done-when-final-product) commits to a configurable list of events AND recipients. [ADR-0021](0021-audit-log-and-notifications-single-write-path.md) established the publisher-over-audit path but left the rule shape and admin surface open.

Forces:

- **Configurability is non-optional.** A hardcoded list turns every rule change into a code change — contrary to Kickoff.
- **Event shape is code-owned.** Each notification template reads specific payload fields. A user-authored event schema drifts against the `mutate()` payload contract.
- **Admin surface widens the trust perimeter.** New CRUD on persistent who-sees-what configuration.
- **Per-user preference matrices explode combinatorially.** Two channels, minimal controls.

## Decision

Notification rules live in a DB-stored table, editable by admins through a minimal CRUD UI. The event catalog is code-defined and closed — adding an event class is a code change plus a migration. A single per-user push-mute toggle controls transient push delivery; the activity feed is the retained history.

Shape:

- **Rule entity** (`notification_rule`): `event_class` (closed enum), `state_filter` (nullable; meaningful only for transition events), `recipient_spec`, `enabled`. Rule CRUD is a direct repository write — it does **not** route through `mutate()`. Rule edits are infrequent admin configuration, not domain events; auditing them dilutes the activity feed for no observed consumer.
- **Event catalog** — code-defined, closed. Initial set: `project.transition_forward`, `project.transition_backward`, `project.archived`, `project.assignment_changed`, `backup.failed`, `disk.threshold_reached`. Adding an event class is a code change plus a migration.
- **Recipient spec** — three-part additive union: role set, `include_assigned_workers` flag (project-scoped events only), explicit user-id list. Resolved recipients = union, deduplicated.
- **Matching semantics** — publisher collects every enabled rule whose `event_class` matches and whose `state_filter` is null or equals `after.status`. Recipients are unioned across matching rules. No priority, no override, no AND/OR trees.
- **Admin CRUD UI** — list + single rule form, gated by `notifications:manage`. The permission gate is the only bar; rule reads are not row-scoped.
- **User-level settings** — single `push_muted` boolean on `UserAccount`. Mutes push across every subscription the user owns; the activity feed is unaffected.
- **Push transport** — browser push to installed PWA, per-device subscription storage (multiple subscriptions per user). The permission prompt is user-initiated from a settings affordance; the app never auto-requests. Protocol and SDK choice live in [ARCHITECTURE.md](../../ARCHITECTURE.md).
- **Rule take-effect** — a rule change affects the next event committed after the change; in-flight events use the rule set read at their own commit moment.
- **Invalid-recipient resilience** — a rule referencing a deactivated or deleted user does not crash dispatch; the missing user is skipped.

## Alternatives Considered

### Hardcoded rule set in a typed array

Ruled out: directly violates the Kickoff configurability commitment — every tweak is a code change and deploy.

### Freeform predicate DSL over `payload`

DB-stored rules with a richer predicate language, templates per rule. Ruled out: a DSL is a parser, evaluator, and security surface (sandboxing, resource limits). Templates reference payload fields only a code change can produce — user-editable templates invite unfixable broken renders. The `state_filter` dropdown is the predicate ceiling the Kickoff warrants.

### Per-user per-event-class preference matrix

Every user × every event-class → receive / suppress. Ruled out: combinatorial explosion, no observed user demand, and `push_muted` + always-on activity feed covers the push-is-annoying case.

### Rule matching with priority / override

Higher-priority rules override lower ones. Ruled out: two matching rules produce a union, not a conflict — priority creates false contradictions where none exist.

### Rule CRUD routed through `mutate()` (rule edits as audit events)

Every rule create/update/delete writes an `audit_log` row and surfaces on the activity feed. Ruled out: complexity cost (audit-snapshot wiring, entity-type expansion, architecture-test allowlist) is not earned by a consumer need. Admin rule edits are infrequent configuration — a read of the rule table answers any "who set this up" question without another audit surface.

## Consequences

### Positive

- Admin tunes notifications without a PR or deploy.
- Flat recipient union — no priority rules to reason about.
- Closed event catalog keeps templates aligned with `mutate()` payload contracts.
- Per-device push subscriptions handle the phone+desktop shape without a per-user preference extension.

### Negative

- New admin CRUD surface — rule-editor routes, UI, permission gate — needs test coverage.
- Event-catalog additions remain code changes — the explicit tradeoff keeping rules aligned with payload shapes.
- Publisher reads two feeds (`audit_log` for mutations, in-process bus for non-mutation events like `backup.failed`). [ADR-0021](0021-audit-log-and-notifications-single-write-path.md) already carved this split.
- Browser push permission is near-irreversible once denied — the settings-affordance-only prompt shifts remediation to the user.
- **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — new admin CRUD, new client push-subscription surface, new service-worker path.

## References

- [Kickoff §Done when](../project/kickoff.md#done-when-final-product) — configurable event list, configurable recipients
- [ADR-0017](0017-soft-delete-as-board-archive.md) — archive = soft-delete, the event source for `project.archived`
- [ADR-0021](0021-audit-log-and-notifications-single-write-path.md) — publisher-over-audit; this ADR extends it
- [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — trigger satisfied
