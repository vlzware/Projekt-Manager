# Data — Persistence and Recovery

Bird's-eye map of how data survives in this system. This file is a navigation aid; all procedures, schemas, and rationale live in the files linked below.

The kickoff commits to automated DB backup ([kickoff line 72](docs/project/kickoff.md#L72)) but declares "a backup concept and system beyond that" out of scope ([kickoff line 80](docs/project/kickoff.md#L80)). The design here is framed accordingly — **mitigation of an unreliable project, not long-term archaeology.** If a data-integrity problem slips past the retention window undetected, recovery is out of scope.

---

## Three layers

Each class of data has different size, portability, and durability properties, so each gets its own tool and its own verification story. The layers are **complementary, not substitutes** — see [ADR-0018](docs/adr/0018-data-persistence-and-recovery-layered-strategy.md) for why.

| Layer                      | Captures                                           | Trigger                    | Off-site            | Status                       |
| -------------------------- | -------------------------------------------------- | -------------------------- | ------------------- | ---------------------------- |
| **1 — Business data**      | Customers, projects, assignments, archived rows    | Manual UI export / restore | No (file download)  | Shipped                      |
| **2 — Full DB state**      | Everything in PostgreSQL (users, sessions, schema) | Scheduled, automatic       | Yes (encrypted, R2) | Shipped                      |
| **3 — Binary attachments** | Uploaded files                                     | Continuous                 | Provider-owned      | Deferred (feature not built) |

---

## Layer 1 — Business data (portability, not DR)

Human-triggered JSON export/import via the **Daten** view. Restore-only semantics (empty target → proceed; non-empty → refuse unless confirmed). IDs preserved, single transaction.

- **Rationale and scope:** [ADR-0018](docs/adr/0018-data-persistence-and-recovery-layered-strategy.md)
- **API contract:** [spec api.md §14.2.4 — Unified Data Exchange](docs/spec/api.md#1424-unified-data-exchange)
- **UI:** [spec ui/daten.md — Daten view](docs/spec/ui/daten.md#811-daten-view)
- **Envelope shape:** [spec data-model.md §5.8](docs/spec/data-model.md#58-export-envelope)
- **Code:** `src/server/services/{ExportService,ImportService}.ts`

Users and sessions are deliberately excluded. Admin bootstrap ([ADR-0010](docs/adr/0010-first-run-admin-bootstrap.md)) handles first-install user creation.

---

## Layer 2 — Full DB state (the DR anchor)

Scheduled encrypted `pg_dump` → R2. Every run is verified on-create (Tier 1); whenever the operator's decryption key is loaded on the VPS, every run is also verified on-cycle (Tier 2). A freshness badge on the login screen and the owner's landing view surfaces failure loudly.

- **Design rationale:** [ADR-0020](docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)
- **Contract:** [spec architecture.md §11.10](docs/spec/architecture.md#1110-full-state-backup-layer-2), [verification.md §15.22](docs/spec/verification.md#1522-backup-and-recovery)
- **Operator procedures:** [docs/ops/backup/](docs/ops/backup/overview.md) — setup, recovery, drills, troubleshooting
- **Code:** `src/server/services/{backup,backup-drill,ephemeralPg,r2Uploader}.ts`; shell wrappers in `scripts/backup/`

**Retention is linear, not GFS:** bucket lock for 14 days, lifecycle delete at 30 days. No weekly/monthly promotion. This is a deliberate scope call — see [ADR-0020 §Decision](docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#decision).

---

## Layer 3 — Binary attachments (deferred)

Uploaded files are not yet a feature of the system. When added, durability will be a property of the storage provider; the system will document the deployment requirement rather than re-implement object-level backup. Tracked via the `storage/` module ([ADR-0018](docs/adr/0018-data-persistence-and-recovery-layered-strategy.md) §Layer 3).

---

## Operator entry points

| I need to…                              | Start here                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| Understand the concept                  | This file                                                                             |
| Bring Layer 2 up on a fresh VPS         | [ops/backup/setup.md](docs/ops/backup/setup.md)                                       |
| Restore the DB from an encrypted backup | [ops/backup/recovery.md](docs/ops/backup/recovery.md)                                 |
| Run the monthly verification drill      | [ops/backup/drills.md](docs/ops/backup/drills.md)                                     |
| Diagnose a broken backup service        | [ops/backup/troubleshooting.md](docs/ops/backup/troubleshooting.md)                   |
| See the full Layer 2 design             | [ADR-0020](docs/adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) |
| Export business data for a peer install | UI → Daten view                                                                       |

---

## Related top-level docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — code navigation guide; Links table points back here.
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, conventions, security-audit trigger.
- [README.md](README.md) — project intro.
