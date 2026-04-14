# Manual Deploy

Pull-based deploy over WireGuard per ADR-0012. CI builds and pushes the image to GHCR; the operator pulls it onto the VPS.

```
push to main/iteration/** -> CI (lint, types, tests, build) -> GHCR image (sha-<commit>, <branch-slug>)
                                                                  |
operator (over WireGuard):                                        v
  ssh vps -> sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [ref]
    -> git fetch + checkout SHA
    -> decrypt secrets.env.age (age passphrase prompt)
    -> docker compose pull app + up -d
    -> smoke test /api/health (60s timeout)
```

## Preconditions

| Requirement                                     | Verify                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `/opt/projekt-manager` is a git clone           | `sudo -u deploy git -C /opt/projekt-manager remote -v`              |
| `age` installed                                 | `command -v age`                                                    |
| `deploy` logged in to GHCR                      | `sudo -u deploy docker pull ghcr.io/vlzware/projekt-manager:main`   |
| `secrets.env.age` exists, owned `deploy:deploy` | `ls -l /opt/projekt-manager/secrets.env.age`                        |
| `deploy` has no interactive login               | `getent passwd deploy` shows `/usr/sbin/nologin`                    |
| `deploy` can fetch from origin                  | `sudo -u deploy git -C /opt/projekt-manager fetch --dry-run origin` |

## Deploy

```bash
# Deploy origin/main (default)
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh

# Deploy an iteration branch
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/iteration/N-name

# Deploy a specific SHA (rollback)
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh <sha>
```

The script: fetches origin, checks out the exact SHA, decrypts `secrets.env.age` via process substitution (plaintext never on disk), sets `APP_IMAGE_TAG=sha-<sha>`, runs `docker compose pull app && docker compose up -d`, polls `/api/health` for 60s.

## Rollback

Same as forward-deploy with an older SHA:

```bash
sudo -u deploy git -C /opt/projekt-manager log --oneline -20   # find good SHA
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh <sha>
```

The GHCR image must still exist. If pruned, use forward-rollback: `git revert` on operator machine, push, wait for CI, redeploy.

## Verify a deploy

```bash
# Running commit
sudo -u deploy git -C /opt/projekt-manager rev-parse --short HEAD

# Container status
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml ps

# Direct health check (bypasses Caddy)
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
  exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"

# From WireGuard client (end-to-end with TLS)
curl -sS https://${DOMAIN}/api/health
```

## Secrets

### Contents of `secrets.env.age`

Three secrets, shell `KEY='value'` format:

- `POSTGRES_PASSWORD`
- `MINIO_ROOT_PASSWORD`
- `CLOUDFLARE_API_TOKEN`

`STORAGE_SECRET_KEY` is NOT in this file -- `docker-compose.yml` derives it from `MINIO_ROOT_PASSWORD` at runtime.

### Rotate a secret

```bash
# On workstation (age must be installed locally)
cat > /tmp/secrets.env <<'EOF'
POSTGRES_PASSWORD='new-value'
MINIO_ROOT_PASSWORD='...'
CLOUDFLARE_API_TOKEN='...'
EOF

age -p -o secrets.env.age /tmp/secrets.env   # enter passphrase
shred -u /tmp/secrets.env

scp secrets.env.age <sudo-user>@vps:/tmp/secrets.env.age
ssh <sudo-user>@vps "sudo mv /tmp/secrets.env.age /opt/projekt-manager/secrets.env.age && sudo chown deploy:deploy /opt/projekt-manager/secrets.env.age && sudo chmod 0600 /opt/projekt-manager/secrets.env.age"

# Redeploy to pick up new values
ssh <sudo-user>@vps "sudo -u deploy /opt/projekt-manager/scripts/deploy.sh"
```

### Passphrase loss recovery

1. Regenerate each secret from its source:
   - `POSTGRES_PASSWORD` -- `ALTER USER` from superuser, or re-provision
   - `MINIO_ROOT_PASSWORD` -- MinIO admin console or `mc admin user`
   - `CLOUDFLARE_API_TOKEN` -- Cloudflare dashboard, scope `Zone:DNS:Edit` + `Zone:Zone:Read`
2. Rebuild `secrets.env`, encrypt with `age -p`, upload
3. Record new passphrase in password manager

### GHCR pull token

- **Location:** `~deploy/.docker/config.json`
- **Scope:** classic PAT, `read:packages` only
- **Rotation:** every 12 months
- **Re-issue:** `sudo -u deploy docker login ghcr.io -u vlzware --password-stdin <<< '<new-PAT>'`

## Bootstrap (first run on fresh VPS)

```bash
# 1. Clone
sudo mkdir -p /opt/projekt-manager
sudo chown deploy:deploy /opt/projekt-manager
sudo -u deploy git clone https://github.com/vlzware/Projekt-Manager.git /opt/projekt-manager

# 2. Install age
sudo apt update && sudo apt install -y age

# 3. GHCR login (classic PAT, read:packages)
sudo -u deploy docker login ghcr.io -u vlzware --password-stdin <<< '<PAT>'

# 4. Upload secrets.env.age (see "Rotate a secret" above for the scp flow)

# 5. First deploy
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main

# 6. Lock down deploy user (ONLY after step 5 succeeds)
sudo usermod -s /usr/sbin/nologin deploy
sudo rm -f /home/deploy/.ssh/authorized_keys

# 7. Prove locked-down flow works
sudo -u deploy bash -c 'cd /opt/projekt-manager && docker compose down'
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main
```

## Failure modes

| Symptom                                | Cause                                               | Fix                                                                  |
| -------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `git checkout` fails                   | Uncommitted changes in working tree                 | `git status`, reset or stash                                         |
| `git checkout landed at X, expected Y` | Post-checkout SHA assertion                         | Inspect `git status`, clean up                                       |
| `age: failed to read identity`         | Wrong passphrase                                    | Retry; verify against password manager after 3 attempts              |
| `docker pull` unauthorized             | GHCR PAT expired                                    | `docker login ghcr.io` as `deploy` with fresh PAT                    |
| Smoke test timeout (60s)               | App container failed or `/api/health` returning 503 | Check `docker compose logs app db storage`                           |
| `no such container` on exec            | `docker compose up -d` did not start `app`          | Check `docker compose ps`; verify `APP_IMAGE_TAG` matches a GHCR tag |
