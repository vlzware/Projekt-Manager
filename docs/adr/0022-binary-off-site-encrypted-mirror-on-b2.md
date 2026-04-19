# ADR-0022: Binary off-site encrypted mirror on Backblaze B2

- **Status:** Accepted
- **Date:** 2026-04-19
- **Confidence:** Medium

## Context

[ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) identifies binary attachments as "storage-provider-owned" and gates implementation on R2 integration (#45). #45 introduces the R2 attachments bucket as primary. That closes Layer 3's primary but not its off-site — R2 becomes the only copy of every uploaded photo and Aufmaß.

Forces:

- **Binaries have no live second copy.** Unlike the DB (which lives on the VPS and is backed up off-site to R2), binaries will live in R2 only. A Cloudflare-side event — account suspension, bucket misconfiguration, token leak, meaningful outage — loses them.
- **Provider independence is the point.** A "secondary" on the same provider as the primary collapses to one failure domain.
- **R2 lacks strong object-lock semantics.** No native versioning, no Compliance-mode Object Lock ([ADR-0020 §Alternatives](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#object-versioning-plus-true-object-lock-compliance-mode)). The primary's 7-day bucket lock from #45 is a short window, not a deep guard.
- **Scope is mitigation, not archaeology.** Kickoff line 80 ("backup system beyond that is out of scope") still constrains depth.
- **Operational cost must stay low.** Operator time is scarcer than storage cost.

Cost research (2026-04-19) compared Backblaze B2, Hetzner Object Storage, Wasabi, Scaleway, AWS S3, iDrive e2, OVH, and Storj. At 50 GB with nightly-sync PUT volume and near-zero restore egress, **B2 Amsterdam** lands at ~€0.28/mo with no floors and supports Compliance-mode Object Lock. **Scaleway** (Paris) is the close runner-up (~€0.38/mo) with stronger EU-sovereignty optics. **Hetzner Object Storage** was ruled out on two grounds: same-provider-as-VPS coupling reduces the independence this ADR is buying, and 2026 capacity degradations at FSN/NBG1 on the Hetzner status page are a present-tense concern.

## Decision

We will add a **Backblaze B2 (Amsterdam) encrypted nightly mirror** of the R2 attachments bucket, reusing the encryption and drill pattern from [ADR-0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md).

Shape:

- **Dedicated B2 account** — separate email and payment method from Cloudflare, so a single payment failure or account-level action cannot reach both providers.
- **B2 bucket** `projekt-manager-attachments-mirror` with **Compliance-mode Object Lock** enabled; retention ≥ the primary's soft-delete cleanup window (current: aligned with #45's 7-day lock, revisit on #45 finalisation).
- **Sync service** runs as a compose service on the VPS on a nightly schedule. Per run: pull changed objects from R2 (rclone or equivalent), encrypt locally with age asymmetric (public recipient in env; private identity never on the VPS), upload to B2. Status surface mirrors ADR-0020 (`meta_backup_status` row + unencrypted `status/latest.json` on B2).
- **Restore drill** operator-loaded via the same `load-drill-key.sh` flow as ADR-0020. Monthly cadence: download a sample set from B2, decrypt on workstation, verify integrity against R2 primary.
- **Runbook** at `docs/ops/backup/` extended with B2 procedures.

## Alternatives Considered

### B2 primary, R2 secondary

Flip the roles — B2 serves the live app, R2 is the encrypted mirror. Ruled out: R2's zero-egress pricing is load-bearing for the live-read workload (mobile workers pulling photos), and B2 bills egress past 3× stored. Storage-cost difference is marginal at this scale and doesn't compensate.

### Hetzner Object Storage for the secondary

Natural fit (Hetzner hosts the VPS). Ruled out on two counts: same-provider coupling with the app host weakens independence (a regional Hetzner event could affect both); 2026 capacity degradations at FSN and NBG1 documented on Hetzner's status page are current, not hypothetical. Revisit if their capacity situation settles.

### Scaleway Object Storage (Paris)

EU-sovereign, nearly identical cost (~€0.38/mo at 50 GB), Compliance-mode Object Lock. Ruled out as _this iteration's_ pick — B2's slightly lower cost, simpler pricing story, and decade-plus operational track record edged it. Promote if a future requirement demands EU-headquartered storage (GDPR optics, public-sector customer).

### Single-provider multi-bucket "isolation"

Use a second R2 bucket in a different R2 account as the secondary. Ruled out: doesn't protect against the provider-level events that motivate off-site in the first place. An illusion of independence.

### Cloud-to-cloud replication via a third-party sync service

Managed replication (AWS DataSync, Rclone Cloud, etc.). Ruled out: over-engineered for the scale; adds another trust boundary and a recurring cost we don't need.

## Consequences

### Positive

- Second physical copy of binaries, off-site, on a distinct provider — closes the single-copy gap flagged by ADR-0018.
- Encryption at rest on an untrusted destination matches the threat model already established in ADR-0020.
- Compliance-mode Object Lock blocks credential-compromise deletions on the secondary — a guard R2 does not provide for the primary.
- Recovery reuses existing tooling (age, operator drill-key flow) — single mental model across DB and binary layers.
- Cost ~€0.28/mo at 50 GB, scaling sub-linearly at current growth.

### Negative

- New external trust boundary — B2 tokens, bucket policy, provider insider risk now inside the security perimeter.
- New account to manage (separate credentials, payment, MFA).
- New moving piece in the compose topology — the sync service needs its own monitoring and health signal.
- **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — new external trust boundary, new credentials. Encryption key flow is unchanged from ADR-0020, so no incremental key-handling risk.
- B2 Amsterdam is single-region; a B2-Amsterdam outage concurrent with an R2 issue could stall recovery. Accepted: catastrophic-concurrent is a tail risk the scope anchor declines to design against.

## References

- [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) — Layer 3 durability gap this ADR closes
- [ADR-0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) — pattern this ADR reuses (encryption, operator drill)
- [Kickoff](../project/kickoff.md) — line 80 (scope anchor — mitigation, not archaeology)
- [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — trigger satisfied
- Issue #45 — R2 attachments bucket (primary)
- Issue #118 — B2 mirror sync service
