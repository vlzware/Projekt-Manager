# ADR-0022: Binary storage on Backblaze B2 with Compliance Object Lock

- **Status:** Accepted
- **Date:** 2026-04-22
- **Confidence:** High

## Context

User-uploaded binaries (photos, Aufmaß, invoices — see [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md)) must be undeletable by the application itself. "Deletion" surfaced to users is a hide operation; real destruction is a storage-layer lifecycle action that no app code path can invoke.

The mechanism requires, on one S3-compatible provider:

- Bucket versioning, so `DeleteObject` produces a delete marker and preserves prior versions.
- Per-version **Compliance** Object Lock retention (Governance is bypassable; Compliance is not).
- A lifecycle rule that reaps hidden versions after the retention window expires.

## Decision

We will store binaries on a **Backblaze B2 bucket**:

- **Versioning:** ON.
- **Object Lock:** Compliance, default retention `N` days at bucket level. Auto-propagates to every upload; no per-upload header handling in app code.
- **Lifecycle:** `daysFromHidingToDeleting = N`, so only the storage layer can destroy bytes, and only after retention expiry.
- **App key:** scoped to the bucket, capabilities `writeFiles, readFiles, listFiles, deleteFiles`. Explicitly excluded: `bypassGovernance`, `writeFileRetentions`, `writeFileLegalHolds`, every `*Bucket*` write capability. Provisioned via the `b2` CLI / API — the web UI cannot scope capabilities below coarse Read/Write.
- **App surface:** storage client gains `hide(key)` (`DeleteObject` on versioned bucket) and `restore(key, versionId)` (`CopyObject` from versionId), both routed through the audit-log `mutate()` path ([ADR-0021](0021-audit-log-and-notifications-single-write-path.md)).
- **Serving:** presigned S3 URLs; clients pull from B2 directly. B2's 3× stored-bytes/month free egress covers the expected workload.
- **Dev parity:** MinIO Object Lock in the compose dev stack — API-shape parity only; not a trust-model claim.

The Compliance guarantee is storage-enforced, not capability-gated. End-to-end verification on a throwaway bucket confirmed that a maximally-permissive key (`deleteFiles`, `bypassGovernance`, `writeFileRetentions`) cannot destroy a retained version, cannot shorten retention, and cannot bypass Compliance with governance-bypass flags. The app-key restriction is defence-in-depth; Object Lock is the primary control.

## Alternatives Considered

### Cloudflare R2

Same S3 API, zero-egress pricing. Rejected: R2's S3 surface omits bucket versioning and per-version Object Lock. R2 Bucket Locks enforce retention-from-creation, not hide-then-delete, which doesn't match the required lifecycle.

### Hetzner Object Storage

Co-located with the VPS. Rejected on independence grounds: same-provider coupling with the application host collapses the storage failure domain into the compute one.

## Consequences

### Positive

- Destruction of binaries within the retention window is provider-enforced and unbypassable, verified end-to-end before implementation.
- Hide/restore expressed with standard S3 ops; no B2-specific SDK.
- VPS stays out of the data path (presigned-URL serving).

### Negative

- Single live copy of binaries. Off-site redundancy for binaries is not addressed here; a separate decision applies if and when B2 account-death or region-outage risk becomes unacceptable.
- Provisioning the restricted app key requires CLI/API tooling — one extra step compared to a clicked credential.
- New external trust boundary (B2 account, credentials). **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit).

## References

- [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) — binary-layer durability context.
- [ADR-0021](0021-audit-log-and-notifications-single-write-path.md) — `mutate()` write path.
- [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)
- [B2 Application Keys](https://www.backblaze.com/docs/cloud-storage-application-keys)
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) — versioning + Object Lock unsupported
- #45 — implementation issue.
