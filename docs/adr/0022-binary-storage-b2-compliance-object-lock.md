# ADR-0022: Binary storage on Backblaze B2 with Compliance Object Lock

- **Status:** Accepted
- **Date:** 2026-04-22 (revised 2026-04-26)
- **Confidence:** High

## Context

User-uploaded binaries (photos, Aufmaß, invoices — see [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md)) must be undeletable by the application itself. "Deletion" surfaced to users is a hide operation; real destruction is a provider-side lifecycle action that no app code path can invoke.

The mechanism combines, on one S3-compatible provider:

- Bucket versioning, so `DeleteObject` produces a delete marker and preserves prior versions.
- Capability granularity — the app's credential can hide but cannot destroy versions.
- Per-version Compliance Object Lock as a finite-window backstop against operator-side mistakes and provider-side surprises.
- A lifecycle rule that reaps hidden versions, providing the trash-bin UX.

## Decision

We will store binaries on a **Backblaze B2 bucket**:

- **Versioning:** ON.
- **Object Lock:** Compliance (not Governance — Governance retention is bypassable by capability, Compliance is not). Default retention `R` days at bucket level, auto-applied per upload; no per-upload header handling in app code.
- **Lifecycle:** `daysFromHidingToDeleting = L`. No other lifecycle rules — `daysFromUploadingToHiding` would auto-hide live data and is explicitly deny-listed in the provisioning runbook.
- **Invariant:** `R ≤ L`. Otherwise trash-bin duration varies with upload age (fresh hidings would reap at `T0 + R`, older at `T_h + L`). With `R ≤ L`, every hide reaps exactly `L` days later. `R` and `L` are independent dials sized for different concerns.
- **Re-upload semantic:** A `PUT` over an existing key creates a new version and demotes the prior version to non-current — without a hide marker. Lifecycle then reaps the prior version `L` days later, with no `hide` event in the audit chain. The upload schema must either prevent overwrites (content-addressed or UUID-keyed) or model overwrite as an explicit replace whose audit captures the implicit demotion.
- **App key:** scoped to the bucket, capabilities `writeFiles, readFiles, listFiles`. Explicitly excluded: `deleteFiles, bypassGovernance, writeFileRetentions, writeFileLegalHolds`, every `*Bucket*` write capability. Provisioned via the `b2` CLI / API — the web UI cannot scope capabilities below coarse Read/Write.
- **App surface:** storage client gains `hide(key)` (`DeleteObject` on versioned bucket, no versionId) and `restore(key, versionId)` (`CopyObject` from versionId), both routed through the audit-log `mutate()` path ([ADR-0021](0021-audit-log-and-notifications-single-write-path.md)).
- **Serving:** presigned S3 URLs; clients pull from B2 directly. B2's 3× stored-bytes/month free egress covers the expected workload.
- **Dev parity:** MinIO Object Lock in the compose dev stack — API-shape parity only; not a trust-model claim.

Two defense layers, with different scopes:

1. **Primary, continuous — capability split.** B2's S3-compat layer dispatches `DeleteObject` by argument to two distinct native operations: without `versionId` → `b2_hide_file` (requires `writeFiles`); with `versionId` → `b2_delete_file_version` (requires `deleteFiles`). The app key lacks `deleteFiles`, so destructive calls are refused with `AccessDenied: not entitled` at the capability check, before any Object Lock evaluation. This holds for the entire lifetime of every version.

2. **Finite-window backstop — Compliance retention.** During the first `R` days of a version's life, no destructive call succeeds, regardless of credential. This catches misuse of the master key, accidental capability drift on the app key, lifecycle misconfiguration, and provider-side surprises. After day `R`, the live version is no longer protected at the storage layer — the capability split is the sole remaining defense for that version. `R` therefore sizes the **operator-mistake recovery window**, not a continuous shield. A compliance-grade retention period would require `R = forever` and would break the lifecycle reap (Object Lock blocks lifecycle deletion of retained versions).

Both layers were verified end-to-end against a throwaway bucket on 2026-04-22 before implementation.

## Alternatives Considered

### Cloudflare R2

Same S3 API, zero-egress pricing. Rejected: R2's S3 surface omits bucket versioning and per-version Object Lock. R2 Bucket Locks enforce retention-from-creation, not hide-then-delete.

### Hetzner Object Storage

Co-located with the VPS. Rejected on independence grounds: same provider as the compute collapses the storage failure domain into the compute one.

### Retention = forever (no real reap)

Pure provider enforcement, infinite. Lifecycle never fires (Object Lock blocks reap on retained versions, indefinitely). "Delete" becomes "hide forever," storage grows monotonically. Rejected: the app needs a bounded trash-bin UX with eventual destruction; unbounded storage is a cost defect.

### Capability split alone (no Object Lock)

Same destruction path; same app code. Rejected: no defense against operator mistakes during the period when they are most likely to bite (initial bucket setup, capability changes, lifecycle edits). The `R`-day backstop is cheap (default retention auto-applies, no app code) and catches a real class of incidents.

## Consequences

### Positive

- Capability layer prevents app-driven destruction permanently and structurally — the missing capability is the enforcement.
- Compliance retention catches operator/provider mistakes during the first `R` days of every version. Verified end-to-end before implementation.
- Hide/restore expressed with standard S3 ops; no B2-specific SDK.
- VPS stays out of the data path (presigned-URL serving).
- No second continuously-running component and no second runtime credential — the lifecycle reap is entirely provider-side.

### Negative

- Single live copy of binaries. Off-site redundancy is not addressed here; a separate decision applies if B2 account-death or region-outage risk becomes unacceptable.
- The Object Lock backstop is a finite window — versions older than `R` days rely on the capability split alone. `R` sized for operator-mistake recovery is **not** a compliance-grade retention period.
- Bucket lifecycle configuration must remain disciplined: any rule other than `daysFromHidingToDeleting = L` (notably `daysFromUploadingToHiding`) would defeat the design. Captured in the provisioning runbook.
- Restricted app key requires `b2` CLI / API to provision; the web UI grants only coarse Read/Write.
- New external trust boundary (B2 account, credentials). The master key has `deleteFiles` and could destroy versions outside their retention window; must be kept offline, rotated, and never used for app traffic. **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit).

## References

- [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) — binary-layer durability context.
- [ADR-0021](0021-audit-log-and-notifications-single-write-path.md) — `mutate()` write path.
- [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)
- [B2 Lifecycle Rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules)
- [B2 Application Keys](https://www.backblaze.com/docs/cloud-storage-application-keys) — capability list, `b2_hide_file` / `b2_delete_file_version` split.
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) — versioning + Object Lock unsupported.
- #45 — implementation.
