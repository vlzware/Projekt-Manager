# Manual deploy — pull-based over WireGuard

## How it works

```
developer push to main or iteration/**
  → CI workflow runs (lint, types, tests, build)
    → build-and-push job builds the app image and pushes to GHCR
      (tags: sha-<commit>, <branch-slug>)
    → STOP. No automatic deploy.

operator (over WireGuard, when ready to deploy):
  ssh vps                                                    (operator's sudo account)
  sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [ref]
    → git fetch + checkout exact SHA
    → decrypt secrets via `age -d` (prompts for passphrase)
    → docker compose pull app (image: ghcr.io/vlzware/projekt-manager:sha-<sha>)
    → docker compose up -d
    → smoke test: wait for /api/health
```

The server is in **detached HEAD** at a specific commit — it does not track a branch. Every deploy checks out the exact SHA that passed CI. No ambiguity about what's running. Rationale for the pull-based topology: see [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md). The image-build leg is unchanged from [ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md).

## Preconditions on the VPS

These are one-time setup items. Most persist across deploys.

| Thing                                                                             | How to verify                                                                                                                                 |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/opt/projekt-manager` is a git clone of `vlzware/Projekt-Manager`                | `sudo -u deploy git -C /opt/projekt-manager remote -v`                                                                                        |
| `age` is installed                                                                | `command -v age`                                                                                                                              |
| `deploy` user is logged in to GHCR                                                | `sudo -u deploy docker pull ghcr.io/vlzware/projekt-manager:main` (should succeed)                                                            |
| `/opt/projekt-manager/secrets.env.age` exists, owned `deploy:deploy`, mode `0640` | `ls -l /opt/projekt-manager/secrets.env.age`                                                                                                  |
| `deploy` user has no interactive login path                                       | `getent passwd deploy` shows `/usr/sbin/nologin`; `ls /home/deploy/.ssh/authorized_keys` returns no such file                                 |
| `deploy` user can still fetch from origin                                         | `sudo -u deploy git -C /opt/projekt-manager fetch --dry-run origin` succeeds (uses the `github_deploy` Deploy Key, untouched by the lockdown) |

## Normal deploy

From a WireGuard-connected machine, logged in as your sudo account:

```bash
# Deploy origin/main (default):
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh

# Deploy a specific iteration branch:
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/iteration/5-consolidation

# Deploy a specific SHA (rollback or targeted):
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh 3721783abc
```

The script:

1. Fetches from origin
2. Resolves the ref to a full SHA and prints `Deploying <ref> -> <sha>`
3. Checks out the SHA and asserts the checkout landed on it
4. Prompts for the age passphrase and decrypts `secrets.env.age` into the shell env via process substitution (plaintext never touches disk)
5. Sets `APP_IMAGE_TAG=sha-<sha>` and runs `docker compose pull app && docker compose up -d`
6. Polls `/api/health` inside the app container for up to 60 seconds
7. Prints `Deploy verified — healthy at <short-sha>` on success, or dumps the last 50 lines of container logs and exits non-zero on failure

## Rollback

Rollback is the same interface as forward-deploy, just with an older SHA:

```bash
# Find the known-good SHA
sudo -u deploy git -C /opt/projekt-manager log --oneline -20

# Deploy it
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh <sha>
```

The GHCR image for that SHA must still exist. Retention is the GHCR built-in policy (ADR-0011), which keeps recent SHA tags indefinitely unless explicitly pruned. If the image was pruned, fall back to a forward-rollback: `git revert` the bad commit on the operator's machine, push, wait for CI, then `./deploy.sh origin/main`.

## Secrets

### Layout

The VPS holds exactly one secret artifact: `/opt/projekt-manager/secrets.env.age`. It contains the runtime secrets required by `docker-compose.yml`:

- `POSTGRES_PASSWORD`
- `MINIO_ROOT_PASSWORD`
- `STORAGE_SECRET_KEY`
- `CLOUDFLARE_API_TOKEN`

Format is shell-compatible `KEY='value'` lines, one per secret. `scripts/deploy.sh` runs `source <(age -d secrets.env.age)` under `set -a` so every assigned variable is auto-exported into the environment that `docker compose` reads.

### Rotating a secret

```bash
# On your workstation (not the VPS):
cat > /tmp/secrets.env <<'EOF'
POSTGRES_PASSWORD='new-value'
MINIO_ROOT_PASSWORD='...'
STORAGE_SECRET_KEY='...'
CLOUDFLARE_API_TOKEN='...'
EOF

age -p -o secrets.env.age /tmp/secrets.env   # enter passphrase
shred -u /tmp/secrets.env

scp secrets.env.age deploy@vps:/opt/projekt-manager/secrets.env.age
ssh vps "sudo chown deploy:deploy /opt/projekt-manager/secrets.env.age && sudo chmod 0640 /opt/projekt-manager/secrets.env.age"

# Trigger a deploy so the new value takes effect:
ssh vps "sudo -u deploy /opt/projekt-manager/scripts/deploy.sh"
```

Keep the passphrase in the project's password manager. It is the single unlock for everything on the VPS.

### Passphrase loss — recovery path

The encrypted file is not irreplaceable. If the passphrase is lost:

1. Retrieve or regenerate each secret from its system of record:
   - `POSTGRES_PASSWORD` — reset via `ALTER USER` from the `postgres` superuser account, or re-provision the container and restore from backup
   - `MINIO_ROOT_PASSWORD`, `STORAGE_SECRET_KEY` — reset via the MinIO admin console or `mc admin user` after re-provisioning
   - `CLOUDFLARE_API_TOKEN` — regenerate in the Cloudflare dashboard under the account's API Tokens panel (scope: `Zone:DNS:Edit` + `Zone:Zone:Read` on the managed zone)
2. Rebuild `secrets.env` with the new values, pick a fresh passphrase, `age -p -o secrets.env.age`, and upload (same as the rotation flow above)
3. Record the new passphrase in the project password manager

### GHCR pull authentication

The `deploy` user holds a GHCR personal access token (classic, scoped `read:packages`) via `docker login`. Treat as a key:

- **Location**: `~deploy/.docker/config.json` on the VPS (base64-encoded)
- **Rotation**: every 12 months, or immediately if the laptop holding the token is compromised
- **Re-issue**: generate a new classic PAT with `read:packages` only, then `sudo -u deploy docker login ghcr.io -u vlzware --password-stdin <<< '<new-PAT>'`

## Verifying a deploy

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
# expect: {"status":"ok",...} (HTTP 200), with a real Let's Encrypt certificate
```

## Smoke test details

After `docker compose up -d`, the deploy script polls the app container's `/api/health` endpoint for up to 60 seconds by running `node -e fetch(...)` inside the app container via `docker compose exec`. This bypasses Caddy and the TLS chain entirely — the TLS path is only reachable from a WG client, so the smoke test validates the application stack (app + db + storage) without depending on the network-layer topology. Verification of the full TLS chain is a manual step from a WireGuard client.

Since #48 the `/api/health` endpoint runs real liveness probes against the DB (`SELECT 1`) and object storage (`HeadBucket`), returning `{status:"ok", checks:{db:"ok", storage:"ok"}}` with HTTP 200 on a fully-healthy stack and `{status:"degraded", ...}` with HTTP 503 when any dependency fails. The smoke test's `r.ok` check correctly interprets 503 as failure.

If the health endpoint does not respond within 60 seconds, the script:

1. Dumps the last 50 lines of container logs
2. Exits non-zero — the operator sees the failure in the same terminal

The app's Docker Compose healthcheck (`/api/health` via `node -e fetch(...)`) also runs independently every 10 seconds and will restart the container after 3 consecutive failures.

## What the deploy user can do

- `git fetch` / `git checkout` inside `/opt/projekt-manager` (read-only repo access)
- `docker compose pull` / `up` / `down` / `logs` / `exec` (member of `docker` group)
- Read `secrets.env.age` (mode `0640`, owner `deploy:deploy`)
- **Cannot log in interactively** — shell is `/usr/sbin/nologin`, `~deploy/.ssh/authorized_keys` is removed. The only way to run a command as `deploy` is via `sudo -u deploy` from an account that already holds a session. The `github_deploy` Deploy Key stays in `~deploy/.ssh/` (outbound-only, read-only repo access) so the deploy script can `git fetch origin`.

The `docker`-group membership is effectively root — see [ADR-0012 §Consequences](../adr/0012-manual-pull-based-deploy-over-wireguard.md#negative--residual-risks) and issue [#72](https://github.com/vlzware/Projekt-Manager/issues/72). This is the residual risk the cutover could not eliminate; the upgrade path is rootless Docker or Podman.

## Bootstrap — first run on a freshly cloned VPS

When a VPS is freshly provisioned (or the deploy script has never been run there before), the script itself does not yet exist at the path the operator wants to invoke. Bootstrap in one session:

```bash
# 1. Clone the repo at /opt/projekt-manager (if not already)
sudo mkdir -p /opt/projekt-manager
sudo chown deploy:deploy /opt/projekt-manager
sudo -u deploy git clone https://github.com/vlzware/Projekt-Manager.git /opt/projekt-manager

# 2. Install age
sudo apt update && sudo apt install -y age

# 3. Log in to GHCR as deploy (use a classic PAT scoped read:packages)
sudo -u deploy docker login ghcr.io -u vlzware --password-stdin <<< '<PAT>'

# 4. Upload the age-encrypted secrets file (from your workstation)
#    (see Secrets § Rotating a secret for the exact scp flow)

# 5. Dry-run the new deploy script
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main

# 6. Only after (5) succeeds: lock down the deploy user.
#    Remove ONLY the inbound key (authorized_keys). Keep github_deploy,
#    github_deploy.pub, config, and known_hosts in place — the deploy
#    script still needs the github_deploy keypair to `git fetch origin`
#    (the repo is private and origin is git@github.com:...).
sudo usermod -s /usr/sbin/nologin deploy
sudo rm -f /home/deploy/.ssh/authorized_keys

# 7. Prove the locked-down flow by re-running end-to-end
sudo -u deploy bash -c 'cd /opt/projekt-manager && docker compose down'
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main
```

Step ordering matters. Do not lock down `deploy` (step 6) until step 5 has completed successfully, so the old SSH login path remains available as a fallback if the new flow needs debugging.

## Common failure modes

| Symptom                                              | Cause                                                                            | Fix                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `git checkout` fails with "unable to update ref"     | Uncommitted changes in the working tree blocking the switch                      | `sudo -u deploy git -C /opt/projekt-manager status`; reset or stash before retrying             |
| `ERROR: git checkout landed at X, expected Y`        | The post-checkout SHA assertion tripped — working tree is in an unexpected state | Inspect `git status`, clean up, re-run                                                          |
| `age: failed to read identity` / wrong passphrase    | Typo or wrong passphrase                                                         | Retry. After 3 wrong attempts, verify the passphrase against the password manager.              |
| `docker pull` fails with `unauthorized`              | GHCR PAT expired or never set                                                    | Re-run `docker login ghcr.io` as `deploy` with a fresh PAT                                      |
| Smoke test times out after 60s                       | App container failed to come up, or `/api/health` returns 503 (degraded)         | Check `docker compose logs app db storage` — the script dumped the last 50 lines before exiting |
| `docker compose exec` fails with "no such container" | `docker compose up -d` did not start the `app` service                           | Check `docker compose ps`; verify `APP_IMAGE_TAG` matches an existing GHCR tag                  |
