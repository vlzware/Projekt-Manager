# Sync VPS → Dev

Destructively overwrites the operator's local dev Postgres database and MinIO bucket with whatever is on the VPS. Mirror of [sync-dev-to-vps.md](sync-dev-to-vps.md) for the opposite direction.

The VPS bucket is Backblaze B2 since the ddff944 topology switch (ADR-0022); the local dev mirror is MinIO. The VPS-side dump helper reads B2 credentials from the running app container's env — no `secrets.env.age` decryption needed during a sync.

```
VPS (over SSH)                                    operator workstation
  docker compose running                            docker compose running (dev overlay via .env COMPOSE_FILE)
    │                                                   │
    │  ssh bash -s ──► pg_dump              (on VPS)    │
    │                  mc mirror B2 → dir   (on VPS)    │
    │                                                   │
    │                  /tmp/pm-rsync-<ts>/              │
    │                        ◄── rsync ──┤              │
    │                                                   │
    │                                    terminate stray backends
    │                                    psql < db.sql
    │                                    mc mirror → MinIO bucket
```

## When to use

- Reproducing a VPS-only bug locally (the whole DB + attachments in one shot).
- Resetting dev to a known-good deployed state without manually recreating users + re-uploading attachments.

## When NOT to use

- You have local-only WIP that isn't on the VPS — this wipes it. Forward-sync first, or keep dev and VPS in sync deliberately.
- Schema drift — script refuses. Check out the matching commit locally (or deploy the matching commit to the VPS) first.

## Preconditions

| Requirement                                | Verify                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `ssh hetzner` reachable as `deploy`        | `ssh -o BatchMode=yes hetzner true`                                                                                            |
| Local dev stack running (`db`, `storage`)  | `docker compose ps db storage`                                                                                                 |
| VPS DB populated (users ≥ 1)               | Checked automatically — would be pointless to pull an empty DB over local                                                      |
| VPS deployed at a schema-compatible commit | Hash-compared automatically (`0000_baseline.sql`)                                                                              |
| `npm run dev` stopped                      | The restore kicks lingering DB connections; the tsx watch process needs a manual restart afterwards to pick up refreshed state |

## Run

```bash
# Preflight only — refuses without the flag
./scripts/sync-vps-to-dev.sh

# Proceed after preflight passes
./scripts/sync-vps-to-dev.sh --i-know
```

Overrides via env:

| Variable     | Default   | Purpose                                         |
| ------------ | --------- | ----------------------------------------------- |
| `SSH_TARGET` | `hetzner` | SSH destination (host alias in `~/.ssh/config`) |

## What the script does

1. Preflight — SSH, local stack, schema parity, non-empty VPS DB.
2. Refuses without `--i-know`; prints exactly what will be overwritten.
3. On VPS: `pg_dump --clean --if-exists --no-owner --no-acl` into `$REMOTE_TMP/db.sql`.
4. On VPS: read STORAGE\_\* from the running `app` container's env, then `mc mirror --overwrite --remove` the B2 bucket into `$REMOTE_TMP/bucket/`.
5. `rsync -az` the VPS temp directory down to local.
6. Locally: `pg_terminate_backend` on every `projekt_manager` connection except our own, then `psql -v ON_ERROR_STOP=1 < db.sql`.
7. Locally: `mc mirror` the pulled bucket into local MinIO (creds read from the local `storage` container's env).
8. Trap-based cleanup: removes `/tmp/pm-rsync-<ts>/` on both ends regardless of outcome.

The VPS-side dump holds a consistent snapshot (pg_dump's default single-transaction mode) and doesn't stop the app — a live user hitting the VPS during sync won't corrupt the dump, they'll just be captured at the snapshot boundary. The B2 mirror is read-only on the VPS side (uses the bucket-scoped app key's `listFiles` + `readFiles` capabilities).

## What gets overwritten

- Local Postgres database `projekt_manager` — every table dropped and recreated.
- Local MinIO bucket `projekt-manager` — objects absent on VPS are deleted.

Untouched: local filesystem, `.env`, VAPID private key under `data/.vapid/`, any `npm run dev` process state (but its open connections are terminated).

## Failure modes

| Symptom                                             | Cause / Fix                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `schema hash mismatch`                              | Local is on a different commit than the VPS. Check out the matching commit locally, or deploy the matching commit to the VPS. |
| `local service 'db' is not running`                 | Start the dev stack: `docker compose up -d`.                                                                                  |
| `VPS users table is empty`                          | VPS hasn't been bootstrapped/seeded. Nothing to pull.                                                                         |
| `ERROR: current transaction is aborted` mid-restore | A stray DB connection beat the `pg_terminate_backend` step. Stop `npm run dev`, retry.                                        |
| Local dev server errors after sync                  | Expected — the connection pool now points at refreshed tables. Restart `npm run dev`.                                         |

## Post-sync checklist

- Restart `npm run dev` — tsx will reconnect against the refreshed DB.
- Log in with any seed user (e.g. `inhaber` / `changeme`) — confirm your local browser session matches what you saw on the VPS.
- Open a project with an attachment — confirm thumbnails render (proves bucket + DB are in sync).

## Relationship to other workflows

- [sync-dev-to-vps.md](sync-dev-to-vps.md) — the forward direction. Use after a reverse-sync + local edits if you want to push the changes back up.
- [manual-deploy.md](manual-deploy.md) — deploy the matching commit to the VPS first if the schema check fails.
- [backup/overview.md](backup/overview.md) — unrelated; Layer 2 encrypted backup is for disaster recovery.
