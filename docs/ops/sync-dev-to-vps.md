# Sync Dev → VPS

Destructively overwrites the VPS's Postgres database and MinIO bucket with whatever is in the operator's local dev stack. Useful while the VPS holds no production data and the iteration requires quickly mirroring local state (seed users, demo customers/projects, attachments) to a live deployment for end-to-end validation.

```
operator workstation                              VPS (over SSH)
  docker compose -f .dev.yml running                 docker compose running (deploy flow)
    │                                                   │
    │  pg_dump (plain SQL) ──┐                          │
    │  mc mirror bucket → dir│                          │
    │                        ├─ rsync ──►  /tmp/pm-sync-<ts>/
    │                                                   │
    │                           ssh bash -s ──► stop app+backup
    │                                           psql < db.sql
    │                                           mc mirror → bucket
    │                                           start app+backup
    │                                           /api/health probe
```

## When to use

- Pushing local dev state to a VPS that has no data worth keeping.
- Reproducing a dev-only bug on the deployed stack.
- Populating a fresh VPS after initial setup (bootstrap admin → sync → done).

## When NOT to use

- VPS holds production data a user has touched through the UI — the sync wipes it.
- Schema drift between local and VPS — script refuses; deploy the matching commit first.
- Layer 2 backups: this script replaces neither disaster-recovery nor drills. See [backup/overview.md](backup/overview.md).

## Preconditions

| Requirement                                | Verify                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ssh hetzner` reachable as `deploy`        | `ssh -o BatchMode=yes hetzner true`                                                                               |
| Local dev stack running (`db`, `storage`)  | `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps db storage`                                    |
| Local DB populated (seeds ran)             | `docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -tAc 'SELECT COUNT(*) FROM users;'` — must be ≥ 1 |
| VPS deployed at a schema-compatible commit | Hash-compared automatically (`0000_baseline.sql`)                                                                 |

The schema check is exact-match on `src/server/db/migrations/0000_baseline.sql`. If it fails, [deploy the matching commit](manual-deploy.md) first, then retry.

## Run

```bash
# Preflight only — refuses without the flag
./scripts/sync-dev-to-vps.sh

# Proceed after preflight passes
./scripts/sync-dev-to-vps.sh --i-know
```

Overrides via env:

| Variable     | Default   | Purpose                                         |
| ------------ | --------- | ----------------------------------------------- |
| `SSH_TARGET` | `hetzner` | SSH destination (host alias in `~/.ssh/config`) |

End-to-end typical timing on a small dataset: ~40 seconds. App downtime on the VPS: the stop → restore → start → health-check window, usually 10–20 seconds.

## What the script does

1. Preflight — SSH, local stack, schema parity, non-empty local DB.
2. Refuses without `--i-know`; prints exactly what will be overwritten.
3. `pg_dump --clean --if-exists --no-owner --no-acl` into `/tmp/pm-sync-<ts>/db.sql`.
4. `mc mirror --overwrite --remove` local bucket into `/tmp/pm-sync-<ts>/bucket/`.
5. `rsync -az` the temp directory to the VPS.
6. On VPS: stop `app` (and `backup` if running) → `psql -v ON_ERROR_STOP=1 < db.sql` → `mc mirror` onto the VPS bucket → start `app` (and `backup`) → poll `/api/health` for 60s.
7. Trap-based cleanup: restarts stopped containers even on failure; removes `/tmp/pm-sync-<ts>/` on both ends.

MinIO credentials on both ends are read from the running `storage` container's env so neither side needs secrets decrypted.

## What gets overwritten

- Postgres database `projekt_manager` — every table is dropped and recreated from the dump, including `users`, `sessions`, `audit_log`, `customers`, `projects`, `attachments`, etc.
- MinIO bucket `projekt-manager` — objects absent in local are deleted, objects present locally are overwritten by key.

Untouched: VPS filesystem, `secrets.env.age`, Caddy config, VAPID private key under `data/.vapid/`, R2 backup archives.

## Failure modes

| Symptom                                    | Cause / Fix                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema hash mismatch`                     | VPS is on a different commit's schema. Deploy the matching commit first.                                                                                          |
| `local service 'db' is not running`        | Start the dev stack: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db storage storage-init`.                                              |
| `local users table is empty`               | Start the app once (`npm run dev`) so migrations + seed run, then retry.                                                                                          |
| `health check failed after 60s`            | Check `ssh hetzner 'docker logs --tail=80 projekt-manager-app-1'`. DB restore may have partially applied — inspect tables and re-run.                             |
| Sync aborts mid-way, app stays down on VPS | The trap starts the app back on exit regardless of failure; confirm with `ssh hetzner 'docker ps'`. If not running, `docker start projekt-manager-app-1` by hand. |

## Post-sync checklist

- Log in with a seed user (e.g. `inhaber` / `changeme`) — confirm session works.
- Open one project with an attachment — confirm the thumbnail renders (proves bucket + DB are in sync on attachment keys).
- If `backup` profile is active, let it ride to the next scheduled tick and confirm it completes — the restore rewrites `meta_backup_status`, so the first post-sync backup starts from a fresh cursor.

## Relationship to other workflows

- [manual-deploy.md](manual-deploy.md) — runs first to get the VPS onto a compatible schema.
- [backup/overview.md](backup/overview.md) — unrelated; Layer 2 encrypted backup is for disaster recovery, not dev→prod mirroring.
- The `/api/export` → `/api/import` flow — business-data-only, validates user refs, requires matching user UUIDs on the target. This script subsumes that use case by carrying the entire DB.
