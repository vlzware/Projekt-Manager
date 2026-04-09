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
      → smoke test 1: wait for app container's /api/health returning {status:"ok"}
      → smoke test 2 (#58): scripts/smoke-e2e.sh — curl over real HTTPS
        through Caddy, login → /api/auth/me → /api/projects → logout
```

The server is always in **detached HEAD** at a specific commit — it does not track a branch. Every deploy checks out the exact SHA that passed CI. No ambiguity about what's running.

## Workflow Files

| File                           | Trigger                           | Purpose                       |
| ------------------------------ | --------------------------------- | ----------------------------- |
| `.github/workflows/ci.yml`     | Push/PR to `main`, `iteration/**` | Lint, type-check, test, build |
| `.github/workflows/deploy.yml` | CI completes successfully         | SSH deploy + smoke test       |

## GitHub Secrets

| Secret                | Purpose                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `DEPLOY_HOST`         | Server public IP (GitHub runners cannot join the WireGuard tunnel, so deploy SSH uses the public IP) |
| `DEPLOY_USER`         | `deploy`                                                                                             |
| `DEPLOY_KEY`          | Private SSH key for the deploy user                                                                  |
| `SMOKE_TEST_USERNAME` | Long-lived smoke-test account username (see "Smoke E2E" below, #58)                                  |
| `SMOKE_TEST_PASSWORD` | Long-lived smoke-test account password                                                               |

## SSH Host Key Pinning

Both SSH steps in `deploy.yml` pin the server's host key fingerprint via the
`fingerprint:` parameter. Without it, the action accepts whatever host key it
sees, so a MITM between the GitHub runner and the VPS could silently
intercept the SSH session and execute arbitrary commands as the deploy user.

**The pinned value is the ECDSA fingerprint, not Ed25519.** This is
counter-intuitive because OpenSSH clients prefer Ed25519 by default, but
`appleboy/ssh-action` uses Go's `crypto/ssh` via `easyssh-proxy`, which
does not set `HostKeyAlgorithms` in its `ClientConfig`. Go's default
preference order puts `ecdsa-sha2-nistp256` before `ssh-ed25519`, so
the server presents its ECDSA host key to the action. Verified
empirically by building a minimal Go SSH client against
`golang.org/x/crypto` v0.49.0 — the `HostKeyCallback` received the
ECDSA key.

Current pinned value (from `/etc/ssh/ssh_host_ecdsa_key.pub`):

```
SHA256:hPKNmL4ZGo8yMqw8q/H0F52chEiW/fnu8NLsUUjgzNA
```

If the VPS is reprovisioned or its host keys are rotated, look up the new
value with:

```sh
ssh deploy@<server-ip> ssh-keygen -l -f /etc/ssh/ssh_host_ecdsa_key.pub | cut -d ' ' -f2
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

## Smoke E2E (#58)

The container-internal smoke test above validates the app's dependencies
but bypasses Caddy, TLS, cookies, and authentication — exactly the parts
most likely to break silently and most visible to real users. After the
internal probe passes, the deploy workflow runs
`scripts/smoke-e2e.sh` on the VPS itself, which:

1. Hits `GET /api/health` through `https://${DOMAIN}` via
   `curl --resolve` against the WireGuard interface IP. Validates the
   real TLS chain, SNI, and that Caddy is forwarding to the app.
2. Logs in as the dedicated smoke-test account, asserting that the
   `Set-Cookie` header carries `Secure`, `HttpOnly`, and
   `SameSite=Strict`.
3. Reads `/api/auth/me` with the cookie — proves the auth middleware
   accepts the session and the app can resolve the user.
4. Reads `/api/projects` with the cookie — proves the DB round-trip
   works end-to-end. No row-count assertions: the smoke test must not
   couple to real production data.
5. Logs out — deletes the session row created by step 2. The only
   persistent state touched is this one transient session, which the
   logout cleans up.

Runs from the VPS (not from a GitHub-hosted runner) because Caddy's
`:443` listener is bound only to the WireGuard interface and
GitHub-hosted runners cannot join the tunnel (#47). Self-hosted runner
infrastructure is a future option for a Playwright-based browser test
that would also catch JS/CSS/CSP regressions, but curl-from-server is
the pragmatic starting point.

### Smoke-test account bootstrap

The smoke-test account is long-lived — one row in the `users` table
with `bookkeeper` role (read-only — a leaked credential must never
grant write access) and a password stored in the GitHub
`SMOKE_TEST_PASSWORD` secret. Password lives in the operator's vault
as the source of truth.

Walking-skeleton scope does not ship a user-management UI, and the
first-run bootstrap mechanism (#57) only fires when the `users` table
is empty. For the one-time account creation, run
`scripts/create-smoke-test-user.sh` on the VPS:

```sh
ssh deploy@<server-ip>
cd /opt/projekt-manager
SMOKE_TEST_USERNAME=smoke \
SMOKE_TEST_PASSWORD='<value from vault>' \
bash scripts/create-smoke-test-user.sh
```

The script is idempotent — re-running with the same username is a
no-op. Rotating the password requires deleting the row first (the
script does not update existing rows, on purpose).

After the account is created, add the credentials to GitHub secrets:

```sh
gh secret set SMOKE_TEST_USERNAME --body 'smoke'
gh secret set SMOKE_TEST_PASSWORD   # prompts for the value
```

The next deploy will exercise the new smoke E2E step with these
credentials.

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
