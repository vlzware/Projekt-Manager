# UI: Project Detail Page

Section 8.15 of the [product spec](../index.md) — the dedicated, shareable detail surface for a single project at `/projects/:id`. The existing Project Detail Panel ([workflow-views.md §8.4](workflow-views.md#84-project-detail-panel)) stays as the quick-glance overlay on Kanban and Calendar; the page is the canonical full-context view.

Shell and navigation live in [index.md](index.md); cross-cutting behavioral rules (in-flight lock, error handling, mutation semantics) in [behavior.md](behavior.md).

---

## 8.15 Project Detail Page

A full-page view of a single project. Reachable by URL (`/projects/:id`) and from the `Öffnen` affordance on the quick-glance detail panel. Route access follows the role matrix — workers land on the not-permitted surface ([AC-149](../verification.md#1521-role-scoping)) when the project is out of their scope.

### 8.15.1 Layout

```
┌──────────────────────────────────────────────────────────┐
│ Header — number, title, status badge, forward/backward   │
├──────────────────────────────────────────────────────────┤
│ Core fields — customer, dates, value, notes              │
├──────────────────────────────────────────────────────────┤
│ Assigned workers — inline editor                         │
├──────────────────────────────────────────────────────────┤
│ Photo gallery — thumbnails + lightbox                    │
├──────────────────────────────────────────────────────────┤
│ Binary list — PDFs, DOCX, other non-photo attachments    │
├──────────────────────────────────────────────────────────┤
│ Activity feed — scoped to this project (see §8.4.1)      │
└──────────────────────────────────────────────────────────┘
```

Every region renders read-only for a caller without the relevant write permission; mutation controls follow [AC-121](../verification.md#1516-management-views).

### 8.15.2 Core Fields

The core-field region reuses the read contents of [workflow-views.md §8.4](workflow-views.md#84-project-detail-panel) — project number and title, status badge, forward/backward transition buttons, customer (name, phone, email, address with map link when present), planned start/end date pickers, estimated value, notes, audit timestamps. Editability parity matches the management edit view ([management.md §8.8.3](management.md#883-edit-project)) — notes, customer, estimated value, dates, and assigned workers are editable with `project:update`. Title edits also go through `project:update`. Status is mutated only through the transition operations; project number is immutable.

### 8.15.3 Assigned-Worker Editor

Worker-assignment editor visible on the page (not routed to a dedicated view). Backed by the existing Update project API operation ([api.md §14.2.2](../api.md#1422-projects)) with a patch carrying `assignedWorkerIds`.

- Multi-select from the active set of users holding the `worker` role. Each selected entry renders as a chip carrying the worker's `displayName`; a remove affordance detaches.
- Mutations require `project:update`. The control is hidden for callers without it; the page-level read surface continues to render the current assigned list.
- Changes are audited per [AC-177](../verification.md#1523-audit-log) — the `mutate()` helper writes a `project_worker` audit row (`action` ∈ `create` / `delete`; `entityLabel` = worker displayName per [data-model.md §5.10](../data-model.md#510-audit-log-entity)).
- In-flight mutation lock per [behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior): while the patch is resolving, the chip set and the add control are disabled; a failed mutation reverts the optimistic UI ([AC-53](../verification.md#153-behavioral)).

### 8.15.4 Photo Gallery

Displays every `status = 'ready'` attachment with `kind = 'photo'` for the project. Thumbnails use the client-generated thumbnail variant via a presigned-GET URL ([api.md §14.2.11](../api.md#14211-attachments)); clicking a thumbnail opens a lightbox that requests the original variant on demand.

- **Upload surface.** Shown for callers with `attachment:write`. An upload affordance supporting drop and explicit browse; on camera-capable devices the affordance additionally invokes camera capture. German CTA copy lives in the attachment upload CTA labels `[C]` catalogue entry ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)).
- **Client image pipeline.** Before calling init, the browser re-encodes the original (preserving EXIF including GPS) and produces a thumbnail variant, applying the sizing and quality parameters in the `[C]` catalogue entry for attachment client-encoding ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)). The browser then computes the MD5 of each blob and passes the size + MD5 of both to init; the server signs one presigned PUT per blob with `Content-Type` + `Content-Length` + `Content-MD5` bound by SigV4. The browser PUTs each blob directly to object storage ([api.md §14.2.11](../api.md#14211-attachments)); the app server never sees the bytes. Preserving EXIF (including GPS) matches [kickoff.md](../../project/kickoff.md)'s worker-view expectation that GPS coordinates stay available to the worker; EXIF preservation as a whole is a design choice of this spec. The concrete transcoding steps and the libraries used live in `ARCHITECTURE.md § Attachments Module — Client image pipeline`.
- **Size cap.** If the re-encoded original exceeds the configured attachment per-file size cap **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)), the client surfaces a German validation message (`"Datei zu groß"`) and does not call init. The cap is also enforced server-side at init validation, then pinned via the presigned PUT's signed `Content-Length`; a mismatch between the two is a client-side bug, not a security gap.
- **Per-photo controls.** Each thumbnail carries a label dropdown (closed enum — `Foto` by default on photo uploads, selectable from the full enum) and a delete affordance. Delete follows the permission matrix in §8.15.6.
- **No offline binary processing.** The service worker does not queue, compress, or resume uploads in the background. A page reload cancels an in-flight upload cleanly; the server-side reaper ([data-model.md §6.11](../data-model.md#611-attachment-orphan-reaper)) removes the orphan `pending` row.

### 8.15.5 Binary List

Displays every `status = 'ready'` attachment with `kind = 'binary'` (PDF, DOCX) for the project. Renders as a tabular list: filename, label, uploader, upload timestamp, download action.

- **Upload surface.** Shown for callers with `attachment:write`. A file picker accepts the binary MIME types from the whitelist ([data-model.md §5.13](../data-model.md#513-attachment)); a file outside the whitelist is rejected client-side with a German validation message (`"Dateityp nicht erlaubt"`).
- **No thumbnail pipeline.** `hasThumbnail = false` at init for binary uploads; the server issues a single presigned-PUT descriptor for the original.
- **Per-file controls.** Label dropdown (closed enum, default `Sonstiges`) and a delete affordance. A `Herunterladen` action requests a download URL ([api.md §14.2.11](../api.md#14211-attachments)) and navigates the browser to it.
- **Bulk download.** A `Auswahl als ZIP` action appears when the user selects at least one file. Selection exceeding the configured bulk-download caps **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) — maximum file count OR summed byte size — is blocked client-side with a German validation message naming both caps. The server re-validates per [api.md §14.2.11](../api.md#14211-attachments); the mismatch path surfaces the same German message via the mutation error banner ([index.md §8.1.2](index.md#812-authenticated-state)).

### 8.15.6 Soft-Hide

The delete affordance is a soft-hide: the row flips to `status = 'hidden'` and the file moves to the project's Papierkorb (§8.15.10). The Papierkorb is bounded — a hidden row is reaped after the configured hide-to-delete window `L` **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) and is then permanently destroyed.

- Owner, office: any attachment on the project.
- Worker: own attachments only, within the configured self-delete grace window **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)). Outside that window the delete control is hidden; the server rejects with `403 NOT_PERMITTED` as the authoritative gate ([api.md §14.2.11](../api.md#14211-attachments)).
- Bookkeeper: no delete.

Every soft-hide carries a Yes / No confirmation dialog with a German warning that names the Papierkorb destination, the bounded Aufbewahrungsfrist during which restore (§8.15.10) is possible, and the irreversible final destruction once that window elapses. Hide is forbidden on archived projects; restore remains permitted on archived projects so binaries are recoverable before lifecycle reap (§8.15.10).

### 8.15.7 Restored Rows Without Backing Bytes

A `status = 'ready'` attachment row whose backing object is absent in storage (possible after a Layer 1 restore whose Layer 3 storage has diverged — see [data-model.md §5.8](../data-model.md#58-export-envelope)) renders in the gallery or list with a neutral German label `"Datei fehlt"` and a muted thumbnail placeholder. The download action is disabled. A "Datei fehlt" row is excluded from the bulk-download selection and from the photo gallery's lightbox. The row is not auto-deleted — the mismatch is an operational signal, not a schema error, and the UI's job is to render it honestly.

**Detection is lazy.** The server does not probe object storage when answering the list endpoint ([api.md §14.2.11](../api.md#14211-attachments)). The UI learns bytes are missing only when the browser follows a presigned-GET URL and the provider responds with a 404 / NoSuchKey. For photos, the trigger is the thumbnail fetch at gallery render — the affected row flips to the "Datei fehlt" placeholder as soon as that fetch fails. For binaries, the list renders normally on mount (no thumbnail fetch); the trigger is the user's download click, at which point the action surfaces the "Datei fehlt" state on the row and suppresses the download. In both cases, a subsequent manual attempt on the same row repeats the fetch and re-observes the same state — no client-side caching of the missing verdict.

### 8.15.8 Upload Failure and Retry

Per-upload states rendered in the gallery and list next to the affected row:

- **Progress.** A percentage or indeterminate indicator while the POST is in flight.
- **Failure banner.** On any failure (network error, storage 4xx/5xx, complete returning a conflict) the row renders a red banner with the German message from the API error category ([behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)) plus a `Erneut versuchen` action that restarts the flow from init. The row is removed from the UI when the user dismisses the banner; the server's reaper removes the orphan `pending` row on its next sweep.
- **No silent retry.** The UI does not retry uploads on its own — silent retry would hide an intermittent failure class from the user. Retry is always a deliberate user action.

### 8.15.9 Permissions Summary

Capability-to-region mapping on the project detail page:

| Region                   | Permission required to see / use                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| View gallery + list      | `attachment:read`                                                                                                                  |
| Upload photo / binary    | `attachment:write` (worker additionally requires project assignment)                                                               |
| Hide an attachment       | `attachment:hide` (soft-hide per ADR-0022; worker additionally requires authorship AND self-delete grace window **[C]** — §8.15.6) |
| Papierkorb tab + restore | `attachment:trash` (list hidden attachments and restore them)                                                                      |
| Bulk download (ZIP)      | `attachment:read`                                                                                                                  |
| Assigned-worker editor   | read inherent to the page; edit requires `project:update`                                                                          |

The role → capability mapping (which role holds `attachment:read`, `attachment:write`, `attachment:hide`, `attachment:trash`) is defined by the permission matrix in [api.md §14.3](../api.md#143-authorization-rules) — that is the SSOT. Server-side authorization is authoritative ([api.md §14.2.11](../api.md#14211-attachments)); client-side hiding is a UX convenience per [AC-121](../verification.md#1516-management-views).

### 8.15.10 Papierkorb Tab

Per-project trash surface listing rows soft-hidden via §8.15.6. Bounded by the configured hide-to-delete window `L` **[C]** ([architecture.md §12.2](../architecture.md#122-company-configurable-settings)) — a hidden row past that window is reaped by the storage lifecycle and is no longer recoverable.

- **Visibility.** Tab is shown only to callers with `attachment:trash` (owner / office under the default matrix). The tab badge carries the trash row count. Server-side authorization remains authoritative: a forbidden caller hitting the API directly receives `403 NOT_PERMITTED` ([AC-235](../verification.md#1526-attachments)).
- **Render states.** `loading` while the initial fetch is in flight, `forbidden` (`403`) for defense-in-depth on direct API calls that bypass tab visibility, `error` with a German message and an `Erneut versuchen` action ([behavior.md §9.5](behavior.md#95-asynchronous-mutation-behavior)), `ready` rendering the list (possibly empty).
- **Empty surface.** A `ready` list with zero rows renders an explicit German label `"Keine gelöschten Dateien"` — distinct from the `loading` placeholder so the user never confuses fetch-in-flight with an empty Papierkorb.
- **Row content.** Filename, label, hidden-since timestamp rendered as a German `Intl.RelativeTimeFormat` string (e.g. `"vor 1 Stunde"`), and a restore action.
- **Restore interaction.** One-click. No confirmation dialog — restore is reversible (a subsequent soft-hide returns the row to the Papierkorb). Server contract pinned by [AC-233](../verification.md#1526-attachments).
- **Archived projects.** Restore is permitted on archived projects — binaries must be recoverable before lifecycle reap consumes the hidden version. Hide remains forbidden on archived projects (read-only previews refuse new mutations); see §8.15.6.
- **Server contract.** List shape, ordering (`hiddenAt DESC`, `id` tiebreaker), and scoping pinned by [AC-235](../verification.md#1526-attachments).

---

_Cross-references: [index.md](../index.md) for scope and assumptions, [data-model.md](../data-model.md) for the Attachment entity, [api.md](../api.md) for the presigned-PUT upload flow, [workflow-views.md §8.4](workflow-views.md#84-project-detail-panel) for the quick-glance overlay, [verification.md](../verification.md) for acceptance criteria._
