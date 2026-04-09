# CD Pipeline — GitHub Actions to Hetzner VPS

## How It Works

```
push to main or iteration/** branch
  → CI workflow runs (lint, types, tests, build)
    → build-and-push job builds the app image and pushes to GHCR
      (tags: sha-<commit>, <branch-slug>)
    → on success: Deploy workflow triggers
      → SSH into VPS as deploy user
      → git fetch + checkout exact SHA that CI tested
      → docker compose pull app (image: ghcr.io/vlzware/projekt-manager:sha-<commit>)
      → docker compose up -d
      → smoke test: wait for /api/health
```

The server is always in **detached HEAD** at a specific commit — it does not track a branch. Every deploy checks out the exact SHA that passed CI. No ambiguity about what's running.

The app image is built in GitHub Actions, not on the VPS. See [ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md) for the rationale. `deploy.yml` pulls from `ghcr.io/vlzware/projekt-manager` tagged with the exact commit SHA — `APP_IMAGE_TAG=sha-$EXPECTED_SHA` is set in the deploy script so the pull is deterministic and rollback via a previous SHA is a one-line change.

## Workflow Files

| File                           | Trigger                           | Purpose                                                                                 |
| ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`     | Push/PR to `main`, `iteration/**` | Lint, type-check, test, build; on push also builds and pushes the app image to GHCR    |
| `.github/workflows/deploy.yml` | CI completes successfully         | SSH to VPS, pull new app image from GHCR, `up -d`, smoke test                           |

## GitHub Secrets

| Secret        | Purpose                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `DEPLOY_HOST` | Server public IP (GitHub runners cannot join the WireGuard tunnel, so deploy SSH uses the public IP) |
| `DEPLOY_USER` | `deploy`                                                                                             |
| `DEPLOY_KEY`  | Private SSH key for the deploy user                                                                  |

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

## Smoke Test

After `docker compose up -d`, the workflow polls the app container's `/api/health` endpoint for up to 60 seconds by running `node -e fetch(...)` inside the app container via `docker compose exec`. This bypasses Caddy and the TLS chain entirely — the TLS path is not reachable from GitHub runners (Caddy binds to the WireGuard interface only), so the smoke test validates the application stack (app + db + storage) without depending on the network-layer topology. Verification of the full TLS chain is a manual step from a WireGuard client, documented in `docs/ops/server-setup.md` Phase 9.

Since #48 the `/api/health` endpoint runs real liveness probes against the DB (`SELECT 1`) and object storage (`HeadBucket`), returning `{status:"ok", checks:{db:"ok", storage:"ok"}}` with HTTP 200 on a fully-healthy stack and `{status:"degraded", ...}` with HTTP 503 when any dependency fails. The smoke test's `r.ok` check correctly interprets 503 as failure.

If the health endpoint does not respond within 60 seconds, the workflow:

1. Dumps the last 50 lines of container logs
2. Fails the deploy — visible in GitHub Actions

The app's Docker Compose healthcheck (`/api/health` via `node -e fetch(...)`) also runs independently every 10 seconds and will restart the container after 3 consecutive failures.

## Rollback

**Via GitHub Actions (preferred):**

Go to Actions → Deploy → find the last successful run → Re-run all jobs. This re-deploys the SHA from that run. With ADR-0011 in place, "re-deploy" is a GHCR pull of the already-built image for that SHA — no rebuild, no VPS resource spike.

**Manual (emergency):**

```bash
ssh -i ~/.ssh/projekt-manager-deploy deploy@<server-ip>
cd /opt/projekt-manager
git log --oneline -10          # find the known-good SHA
git checkout <sha>
export APP_IMAGE_TAG="sha-<sha>"   # must match the full commit SHA
docker compose pull app
docker compose up -d
```

The image for any deployed SHA is retained in GHCR (see ADR-0011 for the retention policy). If the image is no longer available (e.g., pruned), fall back to a forward-rollback: `git revert` the bad commit and push, which triggers a fresh CI build and deploy.

## Caveats

- **`workflow_run` uses the workflow file from the default branch.** Changes to `deploy.yml` only take effect when they are on `main`. During iteration work, if the deploy workflow itself needs a change, cherry-pick or commit it to `main` directly.
- **For a production deployment**, change the `branches` filter in `deploy.yml` to `[main]` only — removing iteration branches restricts deploys to completed, merged work.

## What the Deploy User Can Do

- `git fetch` / `git checkout` (read-only Deploy Key on GitHub)
- `docker compose pull` / `up` / `down` / `logs` / `exec` (member of `docker` group)
- `docker compose build` is no longer part of the deploy path — the app image comes from GHCR (ADR-0011). `build` is still available to the user via group membership, but normal operations do not use it.
- No `sudo`, no write access outside `/opt/projekt-manager`

## Diagram

```
┌────────────────────┐     ┌──────────────────────┐     ┌───────────┐
│   Developer push   │────▶│   CI (GitHub runner) │────▶│   GHCR    │
│                    │     │   lint, test, build, │ push│ sha-<...> │
│                    │     │   build+push image   │     │ <branch>  │
└────────────────────┘     └──────────┬───────────┘     └─────┬─────┘
                                      │ on success             │
                                      ▼                        │
                           ┌──────────────────────┐            │
                           │  Deploy (GH runner)  │            │
                           │  SSH into VPS        │            │
                           └──────────┬───────────┘            │
                                      │                        │
                                      ▼                        │
                           ┌──────────────────────┐            │
                           │  VPS (deploy user)   │            │
                           │  git checkout <sha>  │◀───────────┘
                           │  docker compose pull │   pull sha-<sha>
                           │  docker compose up   │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  Smoke test          │
                           │  /api/health via exec│
                           └──────────────────────┘
```
