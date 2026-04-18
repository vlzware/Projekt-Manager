# UI: Daten View

Section 8.11 of the [product spec](../index.md) — the unified business-data exchange surface (restore + export). See [ADR-0018](../../adr/0018-data-persistence-and-recovery-layered-strategy.md) for the layered persistence strategy and [api.md §14.2.4](../api.md#1424-unified-data-exchange) for the server contract.

---

## 8.11 Daten View

The view surfaces the unified data-exchange operations ([api.md §14.2.4](../api.md#1424-unified-data-exchange)). Visible only to users with `data:export`; the restore form is visible only to users who additionally hold `data:restore`.

### 8.11.1 Restore

A single form accepts one unified JSON envelope. Restore-only semantics — there is no per-entity import. The operation replaces the business-data layer; it is intended as manual disaster recovery from a previously exported envelope.

**Workflow:**

1. **Upload** — user selects the envelope file.
2. **Dry-run preview** — the client submits the envelope to the import endpoint with the dry-run flag. The server validates the envelope (schema version, intra-envelope referential integrity, missing-user references against the target database, row-level constraints) and returns a preview of what would be written, including whether the target database is non-empty. The preview renders per-entity counts and any validation errors, including any missing-user-reference issues that would cause a `MISSING_USER_REFS` rejection on commit (see [api.md §14.2.4](../api.md#1424-unified-data-exchange)). No writes occur.
3. **Destructive-action confirmation** — when the preview indicates the target database is non-empty, the form renders a visually distinct confirmation input labelled with a German destructive-action message, naming the configured confirmation phrase **[C]**. The commit action remains disabled until the typed value matches the configured phrase. Client-side matching is a UX affordance; the server re-validates the phrase and rejects mismatches (see [api.md §14.2.4](../api.md#1424-unified-data-exchange)).
4. **Commit** — user confirms. The client re-submits the envelope without the dry-run flag, adding the override flag when the target was flagged non-empty, and attaching the typed confirmation phrase on that path. The server applies the restore in a single transaction; partial outcomes cannot occur. On success, the UI shows a summary of the restored counts. On failure, the UI surfaces the German error message from the API error category and no state has changed.

Permission: `data:restore`. Users without this permission do not see the restore form.

### 8.11.2 Export

A single **"Herunterladen"** action produces the unified envelope.

**Workflow:**

1. **Download** — user clicks the action. The client fetches the export endpoint and saves the response as a JSON file. Filename format: `projekt-manager-export-<YYYY-MM-DD>T<HH-mm-ss>.json` — the timestamp is a user-convenience cue, not a format contract.

Permission: `data:export`. Users without this permission do not see the Daten navigation tab ([index.md §8.7.1](index.md#871-views)); the export section inside the Daten view is additionally gated at the component level and is not rendered for a caller without `data:export`, even if the route becomes reachable (defense in depth — see [AC-150](../verification.md#1521-role-scoping)). The server remains authoritative ([AC-133](../verification.md#1514-data-exchange)).

The envelope includes archived (soft-deleted) business data with its archive state preserved. Users, sessions, and password hashes are never included.
