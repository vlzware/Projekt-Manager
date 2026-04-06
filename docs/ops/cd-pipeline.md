# CD Pipeline — GitHub Actions to Hetzner VPS

## How It Works

```
push to main or iteration/** branch
  → CI workflow runs (lint, types, tests, build)
    → on success: Deploy workflow triggers
      → SSH into VPS as deploy user
      → git fetch + checkout exact SHA that CI tested
      → docker compose build + up
      → smoke test: wait for /api/health
```

The server is always in **detached HEAD** at a specific commit — it does not track a branch. Every deploy checks out the exact SHA that passed CI. No ambiguity about what's running.

## Workflow Files

| File | Trigger | Purpose |
|------|---------|---------|
| `.github/workflows/ci.yml` | Push/PR to `main`, `iteration/**` | Lint, type-check, test, build |
| `.github/workflows/deploy.yml` | CI completes successfully | SSH deploy + smoke test |

## GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `DEPLOY_HOST` | Server public IP (not Tailscale — GitHub runners can't join the tailnet) |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KEY` | Private SSH key for the deploy user |

## Verifying a Deploy

**From GitHub Actions** (audit trail): check the Deploy workflow run — the smoke test step prints the deployed SHA.

**From the server** (logged in as admin user):

```bash
# What commit is running
sudo -u deploy git -C /opt/projekt-manager rev-parse --short HEAD

# Container status
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml ps

# Health check (localhost bypasses TLS — this is expected)
curl http://localhost/api/health
```

## What Gets Deployed When

- **During an iteration:** every push to `iteration/N-name` that passes CI triggers a deploy.
- **After iteration completion:** the iteration branch merges to `main`, which triggers CI → deploy.
- **Concurrency:** only one deploy runs at a time. If a newer push arrives mid-deploy, the in-progress deploy is cancelled.

## Smoke Test

After `docker compose up -d`, the workflow polls `http://localhost/api/health` for up to 60 seconds. If the health endpoint does not respond, the workflow:

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
- No `sudo`, no write access outside `/opt/projekt-manager`

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
