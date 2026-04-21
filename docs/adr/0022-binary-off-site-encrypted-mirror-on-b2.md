# ADR-0022: Binary off-site encrypted mirror on Backblaze B2

- **Status:** Accepted
- **Date:** 2026-04-19
- **Confidence:** Medium

## Context

[ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) identifies binary attachments as "storage-provider-owned" and gates implementation on R2 integration (#45). #45 introduces the R2 attachments bucket as primary. That closes Layer 3's primary but not its off-site — R2 becomes the only copy of every uploaded photo and Aufmaß.

Forces:

- **Binaries have no live second copy.** Unlike the DB, binaries live in R2 only. A Cloudflare-side event (account suspension, bucket misconfiguration, token leak) loses them.
- **Provider independence is the point.** A secondary on the same provider collapses to one failure domain.
- **R2 lacks strong object-lock semantics** — no native versioning, no Compliance-mode Object Lock. The primary's 7-day bucket lock from #45 is a short window.
- **Scope is mitigation, not archaeology.** Kickoff scopes backup depth; multi-month archaeology is out.
- **Operational cost must stay low.** Operator time is scarcer than storage cost.

Cost research narrowed the field to **B2 Amsterdam** (~€0.28/mo at 50 GB, Compliance-mode Object Lock) and **Scaleway Paris** (~€0.38/mo, EU-sovereign). Hetzner Object Storage was excluded: same-provider coupling with the VPS defeats the independence this ADR buys.

## Decision

We will add a **Backblaze B2 (Amsterdam) encrypted nightly mirror** of the R2 attachments bucket, reusing the encryption and drill pattern from [ADR-0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md).

Shape:

- **Dedicated B2 account** — separate email and payment method from Cloudflare, so a single payment failure or account-level action cannot reach both providers.
- **B2 bucket** with **Compliance-mode Object Lock** enabled; retention ≥ the primary's soft-delete cleanup window.
- **Sync service** as a compose service on the VPS on a nightly schedule. Per run: pull changed objects from R2, encrypt locally with age asymmetric (public recipient in env; private identity never on the VPS), upload to B2. Status surface mirrors ADR-0020.
- **Restore drill** operator-loaded via the `load-drill-key.sh` flow from ADR-0020, monthly cadence.
- **Runbook** at `docs/ops/backup/` extended with B2 procedures.

## Alternatives Considered

### B2 primary, R2 secondary

Flip the roles. Ruled out: R2's zero-egress pricing is load-bearing for the live-read workload (mobile workers pulling photos); B2 bills egress past 3× stored. Storage-cost difference is marginal at this scale and doesn't compensate.

### Hetzner Object Storage for the secondary

Natural fit (Hetzner hosts the VPS). Ruled out on independence grounds: same-provider coupling with the app host weakens the off-site guarantee.

### Scaleway Object Storage (Paris)

EU-sovereign, similar cost (~€0.38/mo at 50 GB), Compliance-mode Object Lock. Ruled out as this ADR's pick — B2's lower cost and longer operational track record edged it.

### Single-provider multi-bucket "isolation"

A second R2 bucket in a different R2 account as the secondary. Ruled out: doesn't protect against the provider-level events that motivate off-site.

### Cloud-to-cloud replication via a third-party sync service

Managed replication (AWS DataSync, Rclone Cloud). Ruled out: over-engineered for the scale; adds a trust boundary and a recurring cost.

## Consequences

### Positive

- Second physical copy of binaries, off-site, on a distinct provider — closes the single-copy gap from ADR-0018.
- Encryption at rest on an untrusted destination matches the ADR-0020 threat model.
- Compliance-mode Object Lock blocks credential-compromise deletions on the secondary — a guard R2 does not provide.
- Recovery reuses existing tooling (age, operator drill-key flow).
- Cost ~€0.28/mo at 50 GB, scaling sub-linearly.

### Negative

- New external trust boundary — B2 tokens, bucket policy, provider insider risk.
- New account to manage (separate credentials, payment, MFA).
- New moving piece in the compose topology — sync service needs its own monitoring.
- B2 Amsterdam is single-region; a B2-Amsterdam outage concurrent with an R2 issue could stall recovery. Accepted: catastrophic-concurrent is a tail risk this ADR does not design against.
- **Security audit required** under [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — new external trust boundary, new credentials. Key flow unchanged from ADR-0020.

## References

- [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) — Layer 3 gap this ADR closes
- [ADR-0020](0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) — pattern reused (encryption, operator drill)
- [Kickoff](../project/kickoff.md) — scope anchor (mitigation, not archaeology)
- [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — trigger satisfied
