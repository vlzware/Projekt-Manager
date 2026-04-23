# Layer 2 Backup — Troubleshooting and Escalation

When `meta_backup_status.lastBackupOk` stays `false`, the service crash-loops, or manifests don't match.

Concept map: [overview.md](overview.md). Setup / rotation: [setup.md](setup.md). DR: [recovery.md](recovery.md).

## First-deploy failure modes

Symptoms that appear during or right after [setup.md §4](setup.md#4-first-deploy):

| Symptom                                     | Likely cause                                           | Fix                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessDenied` writing to R2                | Token scoped to the wrong bucket                       | Recreate token per [setup.md §1.4](setup.md#14-create-the-api-token), rerun [§3](setup.md#3-push-r2-credentials--recipient-to-the-vps), redeploy. |
| `Key not recognised` / `no valid recipient` | `AGE_RECIPIENT` is the private identity, not `age1...` | Rerun [setup.md §2](setup.md#2-generate-the-age-key-pair) extraction with `age-keygen -y`, rerun §3.                                              |
| `meta_backup_status.lastBackupOk = false`   | Tier 1 mismatch or upload failure                      | See "First-line diagnostics" below.                                                                                                               |
| No row in `meta_backup_status` at all       | Cron never fired; service crash-looping                | See "First-line diagnostics" below.                                                                                                               |

## First-line diagnostics (5 minutes)

SSH to the VPS as the admin user, then run these via `sudo -u deploy`. Use `docker` directly, not `pm-compose.sh` — the wrapper re-parses `docker-compose.yml` on every invocation, which requires every interpolation var (`POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `CLOUDFLARE_API_TOKEN`) in shell env. Those live only in `secrets.env.age`; the admin's sudo shell doesn't have them sourced, so compose parse aborts with `CLOUDFLARE_API_TOKEN must be declared`. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903).

```bash
sudo -u deploy docker ps -a --filter name=projekt-manager-backup
sudo -u deploy docker logs projekt-manager-backup-1 --tail=200
sudo -u deploy docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -c 'SELECT * FROM meta_backup_status;'
```

`lastError` is a short machine cue from the backup script — the log tail carries the detail.

## Second-line (manual one-shot, deep-dive)

Trigger a backup manually and read the full output. This `docker exec`s into the running backup container; the scheduled `crond` loop keeps running, but the in-container `/tmp/backup.lock` flock serialises cron-triggered and manual runs, so neither overlaps:

```bash
sudo -u deploy docker exec projekt-manager-backup-1 /usr/local/bin/run-backup.sh
```

If the container isn't running (e.g. crash-looping on the entrypoint's env validation), `docker logs` from First-line diagnostics is the starting point, not this — `docker exec` needs a live PID 1.

Common buckets:

- R2 credential drift — re-run [setup.md §3](setup.md#3-push-r2-credentials--recipient-to-the-vps).
- Age recipient mismatch — re-run [setup.md §3](setup.md#3-push-r2-credentials--recipient-to-the-vps) with `age-keygen -y`.
- PostgreSQL connectivity — check `db` container health.
- Manifest algorithm drift — check [AC-174](../../spec/verification.md#1522-backup-and-recovery) determinism; run the checksum query twice on the same snapshot and compare.

## Escalation threshold

If you cannot restore the most recent green-labelled backup to a scratch DB per [recovery.md steps 1–5](recovery.md), the backup is not a backup. Do not accept the system as healthy.

Next steps:

1. Step back one day and retry.
2. If every available dump fails, prepare for full reconstruction from Layer 1 business-data export ([api.md §14.2.4](../../spec/api.md#1424-unified-data-exchange)) plus a fresh admin bootstrap (see the "First-login ritual" phase in [server-setup.md](../server-setup.md)).

This reconstruction loses users, sessions, and audit FKs — it is worst-case recovery, not a replacement for Layer 2.

## Owner / escalation contact

The project is currently single-operator. The owner (Vladimir) is the escalation contact for every failure class above. If the owner is unavailable and the outage blocks business operations, the fallback plan is the Layer 1 business-data export ([ADR-0018](../../adr/0018-data-persistence-and-recovery-layered-strategy.md)) restored onto a fresh bootstrap — partial recovery, no users/sessions/audit, but projects and customers survive.

Review this section at every staffing change.
