# ADR-0020: Layer 2 — encrypted R2 backups with operator-loaded drills

- **Status:** Accepted
- **Date:** 2026-04-17
- **Confidence:** Medium

## Context

[ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) defines a three-layer persistence strategy. Layer 1 (app-level business-data export/import) is shipped and verified; Layer 3 (binary attachments) is deferred. Layer 2 — a full-state PostgreSQL backup that covers users, sessions, schema, and audit FKs which Layer 1 deliberately omits — is documented as strategy but has no concrete implementation. Iteration 7 needs the implementation shape, because "a backup that is never restored is not a backup" ([ADR-0018 §Context](0018-data-persistence-and-recovery-layered-strategy.md#context)) and until Layer 2 actually runs, disaster recovery is hypothetical.

Forces:

- **Off-site is non-negotiable.** The VPS is a single point of physical failure; a dump kept on the same host is not a backup ([ADR-0018 §Consequences](0018-data-persistence-and-recovery-layered-strategy.md#consequences)).
- **Destination is untrusted.** A storage provider token leak, provider insider, or accidental bucket misconfiguration must not expose customer and user data in plaintext.
- **Restore must be continuously verified.** A restore that has never succeeded on this shape of data cannot be relied on under pressure.
- **Compose is the source of truth** for deployment ([ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md)). A host-managed scheduler would split that source across two surfaces.
- **No human at every backup.** Any design that needs a live operator per run defeats the schedule.
- **Operator laptop is the one trusted enclave** for long-lived decrypt material — the VPS and CI are not.

## Decision

We will add a dedicated **`backup` compose service** that runs on a configurable interval and produces, per run, three R2 objects in the `projekt-manager-backups` bucket: an encrypted `pg_dump -Fc` artifact at `daily/<iso-timestamp>.dump.age`, an encrypted per-table manifest sidecar at `daily/<iso-timestamp>.manifest.json.age` (row count + deterministic content checksum), and an unencrypted `status/latest.json` mirror of the in-DB backup-status row.

- **Encryption** uses **age asymmetric**: the public recipient key ships in container env; the private identity lives only on the operator's laptop. For drills, the operator loads the identity into a tmpfs mount on the VPS via a helper script; it never persists to disk and is lost on reboot.
- **Storage** uses R2 with bucket locks (14-day retention) plus a lifecycle rule deleting objects 30 days after upload. Effective behaviour: immutable for 14 days, deletable for the next 16. R2 object versioning is not used — each run writes a uniquely timestamped filename, so there is no version chain to manage.
- **Retention** follows GFS-style rotation — 7 daily, 4 weekly, 12 monthly. Promotion and cleanup of unpinned dailies happens in the backup script after upload; R2 lifecycle issues the actual deletes.
- **Verification runs every backup**, at two tiers:
  - **Tier 1 — verify-on-create** (unattended): restore the freshly produced plaintext dump into an ephemeral Postgres inside the backup container (initdb + postgres binary over a unix socket — not a sibling container), recompute the per-table manifest, compare to source. Mismatch fails the run — no upload, status reports failure.
  - **Tier 2 — verify-on-cycle** (requires operator key): download the just-uploaded encrypted dump from R2, decrypt with the tmpfs-resident identity, restore into ephemeral Postgres, compare manifest. Key absent = drill is skipped with a distinct log line; this is not a failure, but freshness surfaces through status.
- **Status surface is dual-write.** Primary: a single-row `meta_backup_status` table in the app DB, read on the owner's landing view and on the login screen. Mirror: `status/latest.json` in R2 (unencrypted), readable without the app. The mirror exists so operators can check backup health while the DB is down.
- **Freshness badge**, owner-only, renders on the owner's landing view and on the login screen. Green = backup and drill both fresh; amber = backup fresh but drill stale ("Drill-Schlüssel neu laden"); red = backup stale or last result was a failure. When the DB is unreachable, the badge renders a neutral "status unknown" state — silent disappearance is a misleading-state defect class ([ADR-0014](0014-ac-tier-system-critical-vs-design.md)).
- **Manifest checksum** per table: `SELECT md5(string_agg(md5(row(t.*)::text), '' ORDER BY <pk>)) FROM <table> t`, computed in the same transactional snapshot pg_dump uses. Deterministic ordering by primary key is load-bearing — two runs on the same data must produce the same checksum.
- **Runbook** lives at `docs/ops/recovery.md` and covers end-to-end setup from zero so throwaway R2 credentials can be rotated safely: bucket creation with lock and lifecycle, token creation, age key generation, adding secrets to `secrets.env.age`, first deploy, `load-drill-key.sh` operation, DR restore procedure, and a monthly operator-side full-cycle verification drill on the laptop.

## Alternatives Considered

### Object versioning plus true Object Lock (Compliance Mode)

Use S3/R2 object versioning with a Compliance-mode lock so no principal — including root — can delete a backup within the retention window. Advantage: strongest ransomware / misconfiguration protection on the industry path. Ruled out: R2 does not currently support native versioning or Object Lock Compliance Mode. Bucket locks plus unique timestamped filenames cover the threat we are exposed to (accidents, token leaks) without emulating a feature the provider does not ship.

### Dual R2 tokens — PUT-only for VPS, full for operator

Scope the VPS credential so a compromise cannot delete history. Advantage: minimises the VPS-side blast radius. Ruled out: R2 token permissions are coarse and do not offer a native PUT-only tier at the required granularity. Bucket locks give equivalent practical protection (deletes are blocked for the retention window regardless of token scope) with less operational complexity.

### Host systemd timer as the cron trigger

Trigger backups from a systemd timer on the VPS instead of cron-in-container. Advantage: systemd provides missed-run recovery natively. Ruled out: it splits "what runs on this host" across compose and host config, breaking the source-of-truth rule in [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md). The missed-run recovery is not worth the drift; a subsequent run quickly catches up because the artifact is self-contained.

### Passphrase-based age encryption

Use age's passphrase mode instead of an asymmetric recipient. Advantage: one less key-management surface. Ruled out: passphrase-based age requires interactive input at every backup, which defeats automation. Asymmetric age allows unattended encryption (public recipient in env) and keeps the private identity entirely off the server.

### Automated CI-based drill

Run the full restore drill from CI on a schedule. Advantage: drill runs without operator attention. Ruled out: CI would need persistent access to a decrypt key, which becomes the whole-history compromise vector — the exact threat encryption is meant to mitigate. Operator-loaded tmpfs isolates the decrypt path to a trusted enclave.

### Dumping users and sessions via app-level export instead of pg_dump

Extend the Layer 1 envelope to cover users and sessions so one artifact captures everything. Advantage: a single restore path. Ruled out: the Layer 1 envelope is deliberately portability-first, not DR — users and sessions are excluded by design (see [ADR-0018 §Decision](0018-data-persistence-and-recovery-layered-strategy.md#decision) and [ADR-0019](0019-worker-data-scoping-repository-layer-predicate.md)). The two layers are complementary; merging them re-introduces the confusion ADR-0018 removed.

## Consequences

### Positive

- Off-site, encrypted full-state backups exist for the first time, covering what Layer 1 cannot (users, sessions, schema, audit FKs).
- Every backup is immediately verified via Tier 1 — a silent corruption fails the run before it reaches R2.
- Tier 2 proves the encrypted round-trip continuously whenever the operator is engaged, without requiring a standing decrypt key on the server.
- Bucket locks make the destination resistant to accidental or token-leak-driven deletion within the retention window.
- Restore can be executed from the operator's laptop with nothing but the envelope file and the private identity — no VPS required.
- The compose-owned `backup` service keeps the deployment topology consistent with [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md).
- The badge's misleading-state-free behaviour (explicit "status unknown" when the DB is unreachable) aligns Layer 2 with the critical-AC tier rules in [ADR-0014](0014-ac-tier-system-critical-vs-design.md).

### Negative

- **New external trust boundary (R2)** — tokens, bucket policy, and provider insider risk now sit in the system's security perimeter.
- **New long-lived encryption keys** — the age recipient is embedded in container env; the private identity must be backed up by the operator on their own schedule, outside the system.
- **New tmpfs-resident secret handling** — the `load-drill-key.sh` flow introduces an operator procedure whose correctness cannot be fully enforced mechanically; a procedural error (e.g., writing the key to a non-tmpfs path) would persist the identity to disk.
- **A security audit is required** before release — new external trust boundary, new encryption keys, new tmpfs private-key handling meet the trigger in [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit).
- Operator must maintain the private identity off-system; losing it forfeits Tier 2 drills and every DR restore from encrypted archives.
- R2 lifecycle lag between backup creation and actual delete means up to 30 days of retained objects per backup — acceptable on the free tier at the current cadence, but the operator must monitor bucket size if the schedule tightens.
- The drill-staleness amber state depends on the operator keeping the key loaded after reboots; documented in the runbook but not system-enforceable.

## References

- [Kickoff](../project/kickoff.md) — automated DB backup as a goal
- [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md) — compose is the source of truth
- [ADR-0014](0014-ac-tier-system-critical-vs-design.md) — misleading state is a critical defect class
- [ADR-0018](0018-data-persistence-and-recovery-layered-strategy.md) — the three-layer persistence model; this ADR is the Layer 2 implementation
- [CONTRIBUTING.md §Security audit](../../CONTRIBUTING.md#security-audit) — trigger satisfied
