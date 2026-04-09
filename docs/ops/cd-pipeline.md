# CD Pipeline — GitHub Actions to Hetzner VPS

## How It Works

```
push to main or iteration/** branch
  → CI workflow runs (lint, types, tests, build)
    → on success: Deploy workflow triggers
      → SSH into VPS as deploy user (with host key fingerprint pinned)
      → git fetch + checkout exact SHA that CI tested
      → pg_dump the live DB to /home/deploy/backups/projekt-manager
        (abort if dump fails or is empty)
      → docker compose build + up
      → smoke test: wait for /api/health returning {status:"ok"}
```

The server is always in **detached HEAD** at a specific commit — it does not track a branch. Every deploy checks out the exact SHA that passed CI. No ambiguity about what's running.

## Workflow Files

| File                           | Trigger                           | Purpose                       |
| ------------------------------ | --------------------------------- | ----------------------------- |
| `.github/workflows/ci.yml`     | Push/PR to `main`, `iteration/**` | Lint, type-check, test, build |
| `.github/workflows/deploy.yml` | CI completes successfully         | SSH deploy + smoke test       |

## GitHub Secrets

| Secret        | Purpose                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `DEPLOY_HOST` | Server public IP (GitHub runners cannot join the WireGuard tunnel, so deploy SSH uses the public IP) |
| `DEPLOY_USER` | `deploy`                                                                                             |
| `DEPLOY_KEY`  | Private SSH key for the deploy user                                                                  |

## SSH Host Key Pinning

Both SSH steps in `deploy.yml` pin the server's host key fingerprint via the
`fingerprint:` parameter. Without it, the action accepts whatever host key it
sees, so a MITM between the GitHub runner and the VPS could silently
intercept the SSH session and execute arbitrary commands as the deploy user.

The current pinned value is the ed25519 fingerprint:

```
SHA256:Ph26z+Ew6IuYP4OxFkYdHMcRo2jzuhBV6az6QGhNkPo
```

If the VPS is reprovisioned or its host keys are rotated, look up the new
value with:

```sh
ssh deploy@<server-ip> ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub | cut -d ' ' -f2
```

and update `deploy.yml` in the same commit that causes the rotation.

## Verifying a Deploy

**From GitHub Actions** (audit trail): check the Deploy workflow run — the smoke test step prints the deployed SHA.

**From the server** (logged in as admin user):

```bash
# What commit is running
sudo -u deploy git -C /opt/projekt-manager rev-parse --short HEAD

# Container status
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml ps

# Health check — probe the app container directly via docker exec.
# Caddy listens only on ${WG_BIND_IP}:443 (the WireGuard interface), so
# `curl http://localhost/api/health` from the server does not work and
# `curl https://localhost/api/health` fails SNI validation. The supported
# path is to bypass Caddy entirely and hit the app's internal listener:
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
  exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"
echo "exit=$?"  # 0 = healthy
```

**From a WireGuard client** (end-to-end including TLS):

```bash
curl -sS https://${DOMAIN}/api/health
# expect: "ok" (HTTP 200), with a real Let's Encrypt certificate
```

## What Gets Deployed When

- **During an iteration:** every push to `iteration/N-name` that passes CI triggers a deploy.
- **After iteration completion:** the iteration branch merges to `main`, which triggers CI → deploy.
- **Concurrency:** only one deploy runs at a time. If a newer push arrives mid-deploy, the in-progress deploy is cancelled.

## Pre-deploy DB Backup

Before `docker compose build app` runs, the deploy step dumps the live
`projekt_manager` database to `/home/deploy/backups/projekt-manager/` on
the VPS via `docker compose exec -T db pg_dump | gzip`. The backup lives
on the same host as the running database, which is enough protection
against a destructive migration rolled out by the deploy but is **not**
a substitute for off-host backups — the host disk failure case is
explicitly out of scope here (tracked separately under #46).

Retention is 14 days of pre-deploy snapshots. Adjust in `deploy.yml`
when the data volume justifies keeping more (or less) history.

If the dump fails or produces an empty file, the deploy aborts before
touching the stack. A migration we cannot roll back via restore must
not proceed — see `CLAUDE.md` §Principles.

## Smoke Test

After `docker compose up -d`, the workflow polls the app container's
`/api/health` endpoint for up to 60 seconds by running `node -e fetch(...)`
inside the app container via `docker compose exec`. This bypasses Caddy
and the TLS chain entirely — the TLS path is not reachable from GitHub
runners (Caddy binds to the WireGuard interface only), so the smoke test
validates the application stack (app + db + storage) without depending
on the network-layer topology. Verification of the full TLS chain is a
manual step from a WireGuard client, documented in
`docs/ops/server-setup.md` Phase 9.

Since #48 the `/api/health` endpoint runs real liveness probes against
the DB (`SELECT 1`) and object storage (`HeadBucket`), returning
`{status:"ok", checks:{db:"ok", storage:"ok"}}` with HTTP 200 on a
fully-healthy stack and `{status:"degraded", ...}` with HTTP 503 when
any dependency fails. The smoke test's `r.ok` check correctly interprets
503 as failure.

If the health endpoint does not respond within 60 seconds, the workflow:

1. Dumps the last 50 lines of container logs
2. Fails the deploy — visible in GitHub Actions

The app's Docker Compose healthcheck (`/api/health` via `node -e fetch(...)`) also runs independently every 10 seconds and will restart the container after 3 consecutive failures.

## Rollback

**Via GitHub Actions (preferred):**

Go to Actions → Deploy → find the last successful run → Re-run all jobs. This re-deploys the SHA from that run.

**Manual (emergency):**

```bash
ssh -i ~/.ssh/projekt-manager-deploy deploy@<server-ip>
cd /opt/projekt-manager
git log --oneline -10          # find the known-good SHA
git checkout <sha>
docker compose build app
docker compose up -d
```

## Caveats

- **`workflow_run` uses the workflow file from the default branch.** Changes to `deploy.yml` only take effect when they are on `main`. During iteration work, if the deploy workflow itself needs a change, cherry-pick or commit it to `main` directly.
- **For a production deployment**, change the `branches` filter in `deploy.yml` to `[main]` only — removing iteration branches restricts deploys to completed, merged work.

## What the Deploy User Can Do

- `git fetch` / `git checkout` (read-only Deploy Key on GitHub)
- `docker compose build` / `up` / `down` / `logs` (member of `docker` group)
- `pg_dump` via `docker compose exec -T db` (for the pre-deploy backup)
- Write access to `/home/deploy/backups/projekt-manager` and `/opt/projekt-manager`
- No `sudo`

### Honest Disclosure: Docker Group = Root

Membership in the `docker` group is functionally equivalent to passwordless
root on the host. A user in the `docker` group can:

```sh
docker run -v /:/host --rm alpine chroot /host sh
```

and gain full root access to the host filesystem. There is no way around
this — the Docker daemon runs as root and anything with the ability to
talk to its socket can escalate.

This is an accepted risk for the walking skeleton. The mitigations are:

- Only one account (`deploy`) is in the `docker` group
- The account has no password and no interactive shell from outside the
  GitHub Actions runner's SSH key
- The SSH key is pinned via `fingerprint` (see above) so the set of
  entities that can even reach this privilege is small

**What this is not:** a long-term posture. Before the project handles
real customer data, the deploy user needs to lose root-equivalent
privileges. The two viable paths are rootless Docker (each user runs
their own daemon) or a sudoers whitelist that only permits the exact
`docker compose` subcommands the deploy workflow uses. Both are tracked
in #48 as deferred work.

## Diagram

```
┌────────────────────┐     ┌──────────────────────┐
│   Developer push   │────▶│   CI (GitHub runner) │
│                    │     │   lint, test, build  │
└────────────────────┘     └──────────┬───────────┘
                                      │ on success
                                      ▼
                           ┌──────────────────────┐
                           │  Deploy (GH runner)  │
                           │  SSH into VPS        │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  VPS (deploy user)   │
                           │  git checkout <sha>  │
                           │  docker compose up   │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  Smoke test          │
                           │  curl /api/health    │
                           └──────────────────────┘
```
