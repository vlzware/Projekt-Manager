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

### 8.11.3 Vollständiger Export

A single **"Vollständiger Export"** action produces one zip carrying both `data.json` (the unified envelope from [§8.11.2](#8112-export)) at the root and every `status='ready'` attachment as plaintext bytes under `attachments/<projektnummer>-<projekt-titel>/<attachment-id>-<dateiname>`. The zip is assembled in the browser via streaming-zip — the server never sees plaintext bulk, mirroring the per-project bulk-fetch path established by [ADR-0024](../../adr/0024-binary-attachment-e2e-encryption.md).

**Workflow:**

1. **Pre-flight dialog** — the client fetches the unified envelope ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Export) and the first page of binary descriptors ([api.md §14.2.4](../api.md#1424-unified-data-exchange) — Binary descriptors), reads `totalCount` and `totalSizeBytes` from the descriptor response, and renders a confirmation dialog naming the attachment count and the aggregate plaintext size as a single up-front readout (server-computed; no growing-under-the-user behavior). Below the configured mobile-warning breakpoint **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) the dialog renders a non-blocking warning: `"Für Desktop-Nutzung gedacht; Downloads können sehr groß sein."` — the user can still proceed.
2. **Drain and assemble** — on confirmation, the client drains the descriptor pages in cursor order. For each entry: if `entries[i].error === 'DEK_UNWRAP_FAILED'` the entry is logged and skipped without attempting a fetch; otherwise the client fetches the ciphertext via `originalUrl`, AES-256-GCM-decrypts with `originalDekMaterial`, and feeds the plaintext bytes into a streaming-zip. Path components are sanitised by the same rules pinned in [AC-245](../verification.md#1526-attachments) for filename validation: 255-character ceiling per component, no control characters (`\x00`–`\x1F`, `\x7F`), no path separators (`/`, `\`), no double-quotes (`"`); a violating character is replaced with an underscore (`_`) and a violating length is truncated. Path layout: `data.json` at the root; `attachments/<projektnummer>-<projekt-titel>/<attachment-id>-<dateiname>`. The prepended `attachment-id` defuses any `(projektnummer, dateiname)` collision. The orchestrator computes the SHA-256 of each plaintext as it streams into the zip — over `data.json` first, then over every successfully-decrypted attachment in cursor order — and accumulates the per-entry tuple `{ zipPath, sizeBytes, sha256, attachmentId? }` into a manifest. After the last attachment entry, the orchestrator writes the manifest to the zip as `manifest.json` at root. Skipped attachments (per step 4) are NOT listed; the manifest reflects what is IN the zip, not what was attempted. The manifest does not list itself. See [AC-252](../verification.md#1514-data-exchange) for the contract.
3. **Streaming progress** — the dialog surfaces files-done / total (counted against `totalCount`), bytes-done / total (computed from `entries[*].sizeBytes` against `totalSizeBytes`), the current file name, and a **"Abbrechen"** action. Cancel halts the in-flight fetch, tears down the streaming-zip, and closes the dialog immediately; any partially-written download is the user's to discard.
4. **Per-file failure handling** — an entry whose descriptor carried `error = 'DEK_UNWRAP_FAILED'` is logged and skipped (see step 2). A presigned URL whose `expiresAt` has passed before the entry is fetched triggers ONE re-fetch of the affected descriptor page; on a second expiry the entry is logged and skipped. A fetch error (storage 4xx / 5xx, network failure on the ciphertext fetch) likewise logs and skips the entry. The export does not abort on a per-entry failure.
5. **Post-export summary** — when the zip finishes, the dialog renders the resulting filename and any skipped-row count: `"X Dateien übersprungen"` when at least one entry was skipped (regardless of skip cause). Filename format: `projekt-manager-vollstaendiger-export-<YYYY-MM-DD>T<HH-mm-ss>.zip` — the timestamp is a user-convenience cue.

If the runtime cannot perform a streaming download (e.g. no controlling Service Worker, no transferable-stream support), the action surfaces a generic export-failed message and is refused. The dialog does NOT perform an up-front feature probe; the failure surfaces on first stream attempt.

Permission: `data:export`. Users without this permission do not see the action — the gate matches [§8.11.2](#8112-export). The server remains authoritative ([AC-133](../verification.md#1514-data-exchange)).
