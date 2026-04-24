# ADR-0022: Binary storage on Backblaze B2 with Compliance Object Lock

- **Status:** Accepted
- **Date:** 2026-04-22
- **Confidence:** High

## Context

User-uploaded binaries (photos, Aufmaß, invoices — see [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md)) must be undeletable by the application itself. "Deletion" surfaced to users is a hide operation; real destruction is a provider lifecycle action that no app code path can invoke.

The mechanism requires, on one S3-compatible provider:

- Bucket versioning, so `DeleteObject` produces a delete marker and preserves prior versions.
- Per-version **Compliance** Object Lock retention (Governance is bypassable; Compliance is not).
- A lifecycle rule that reaps hidden versions after retention expires.
- Capability granularity such that the app's credential can hide but not destroy.

## Decision

We will store binaries on a **Backblaze B2 bucket**:

- **Versioning:** ON.
- **Object Lock:** Compliance, default retention `N` days at bucket level. Auto-propagates to every upload; no per-upload header handling in app code.
- **Lifecycle:** `daysFromHidingToDeleting = N`. Only the storage layer can destroy bytes, and only after retention expires.
- **App key:** scoped to the bucket, capabilities `writeFiles, readFiles, listFiles`. Explicitly excluded: `deleteFiles`, `bypassGovernance`, `writeFileRetentions`, `writeFileLegalHolds`, every `*Bucket*` write capability. Provisioned via the `b2` CLI / API — the web UI cannot scope capabilities below coarse Read/Write.
- **App surface:** storage client gains `hide(key)` (`DeleteObject` on versioned bucket, no versionId) and `restore(key, versionId)` (`CopyObject` from versionId), both routed through the audit-log `mutate()` path ([ADR-0021](0021-audit-log-and-notifications-single-write-path.md)).
- **Serving:** presigned S3 URLs; clients pull from B2 directly. B2's 3× stored-bytes/month free egress covers the expected workload.
- **Dev parity:** MinIO Object Lock in the compose dev stack — API-shape parity only; not a trust-model claim.

Two independent defense layers protect the binaries:

1. **Capability layer.** B2's S3-compat `DeleteObject` dispatches by argument to two distinct native operations: without `versionId` → `b2_hide_file` (requires `writeFiles`); with `versionId` → `b2_delete_file_version` (requires `deleteFiles`). The app key lacks `deleteFiles`, so destructive calls are refused with `AccessDenied: not entitled` at the capability check, before any Object Lock evaluation.
2. **Storage layer.** Compliance retention blocks `DeleteObjectVersion` on retained versions regardless of capabilities. `bypassGovernance` is a no-op against Compliance; retention can be extended, not shortened.

Both layers were verified end-to-end against a throwaway bucket on 2026-04-22 before implementation.

## Alternatives Considered

### Cloudflare R2

Same S3 API, zero-egress pricing. Rejected: R2's S3 surface omits bucket versioning and per-version Object Lock. R2 Bucket Locks enforce retention-from-creation, not hide-then-delete.

### Hetzner Object Storage

Co-located with the VPS. Rejected on independence grounds: same provider as the compute collapses the storage failure domain into the compute one.

## Consequences

### Positive

- The app's credential cannot destroy bytes — structurally (missing capability) and redundantly (Compliance retention). Verified end-to-end before implementation.
- Hide/restore expressed with standard S3 ops; no B2-specific SDK.
- VPS stays out of the data path (presigned-URL serving).
- No second continuously-running component and no second runtime credential — the lifecycle reap is entirely provider-side.

### Negative

- Single live copy of binaries. Off-site redundancy is not addressed here; a separate decision applies if B2 account-death or region-outage risk becomes unacceptable.
- Restricted app key requires `b2` CLI / API to provision; the web UI grants only coarse Read/Write.
- New external trust boundary (B2 account, credentials). **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit).

## References

- [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) — binary-layer durability context.
- [ADR-0021](0021-audit-log-and-notifications-single-write-path.md) — `mutate()` write path.
- [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)
- [B2 Application Keys](https://www.backblaze.com/docs/cloud-storage-application-keys) — capability list, `b2_hide_file` / `b2_delete_file_version` split.
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) — versioning + Object Lock unsupported.
- #45 — implementation.
