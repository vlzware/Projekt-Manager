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

`scripts/ops/pm-compose.sh` pins `APP_IMAGE_TAG` to the current HEAD so the gated `app` + `backup` services interpolate — every manual `docker compose` call outside `scripts/deploy.sh` needs this (see the wrapper's header).

```bash
# Running commit
sudo -u deploy git -C /opt/projekt-manager rev-parse --short HEAD

# Container status
sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh ps

# Direct health check (bypasses Caddy)
sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh \
  exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"

# From WireGuard client (end-to-end with TLS)
curl -sS https://${DOMAIN}/api/health
```

## Secrets

### Contents of `secrets.env.age`

Shell `KEY='value'` format. Three Layer 1 secrets (app + TLS) and six Layer 2 secrets (offsite backup — ADR-0020; R2 values from [backup/setup.md §1.4](backup/setup.md#14-create-the-api-token), age recipient from [§2](backup/setup.md#2-generate-the-age-key-pair)):

Layer 1:

- `POSTGRES_PASSWORD`
- `MINIO_ROOT_PASSWORD`
- `CLOUDFLARE_API_TOKEN`

Layer 2:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT` -- `https://<accountid>.r2.cloudflarestorage.com`
- `R2_BUCKET` -- optional; defaults to `projekt-manager-backups` in `docker-compose.yml`
- `R2_REGION` -- optional; defaults to `auto` in `docker-compose.yml`
- `AGE_RECIPIENT` -- PUBLIC recipient only, for backup encryption at rest. The matching age identity lives on the operator workstation, never on the VPS.

`STORAGE_SECRET_KEY` is NOT in this file -- `docker-compose.yml` derives it from `MINIO_ROOT_PASSWORD` at runtime.

### Rotate a secret

`age` re-encrypts the whole file, so rotating one value means writing all of them back. The full setup procedure (including per-secret sources) lives in [backup/setup.md §3](backup/setup.md#3-push-r2-credentials--recipient-to-the-vps). Short form for rotating one existing value:

```bash
# On workstation (age must be installed locally). Decrypt current file
# to recover the non-rotated values, edit in place, re-encrypt.
age -d secrets.env.age > /tmp/secrets.env   # enter passphrase
$EDITOR /tmp/secrets.env                     # change the one value
age -p -o secrets.env.age.new /tmp/secrets.env   # enter passphrase
shred -u /tmp/secrets.env
mv secrets.env.age.new secrets.env.age

scp secrets.env.age <sudo-user>@vps:/tmp/secrets.env.age
ssh <sudo-user>@vps "sudo mv /tmp/secrets.env.age /opt/projekt-manager/secrets.env.age && sudo chown deploy:deploy /opt/projekt-manager/secrets.env.age && sudo chmod 0600 /opt/projekt-manager/secrets.env.age"

# Redeploy to pick up new values
ssh <sudo-user>@vps "sudo -u deploy /opt/projekt-manager/scripts/deploy.sh"
```

### Passphrase loss recovery

1. Regenerate or re-read each secret from its source:
   - `POSTGRES_PASSWORD` -- `ALTER USER` from superuser, or re-provision
   - `MINIO_ROOT_PASSWORD` -- MinIO admin console or `mc admin user`
   - `CLOUDFLARE_API_TOKEN` -- Cloudflare dashboard, scope `Zone:DNS:Edit` + `Zone:Zone:Read`
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` -- issue a new R2 API token in the Cloudflare dashboard; the endpoint URL is listed alongside. Revoke the old token after the rotation deploy.
   - `R2_BUCKET`, `R2_REGION` -- read off the R2 dashboard (or fall back to the compose defaults).
   - `AGE_RECIPIENT` -- not affected by `secrets.env.age` passphrase loss. Derive from the existing identity on the operator workstation: `age-keygen -y ~/secrets/age-backup.key`.
2. Rebuild `secrets.env`, encrypt with `age -p`, upload (see [backup/setup.md §3](backup/setup.md#3-push-r2-credentials--recipient-to-the-vps)).
3. Record new passphrase in password manager.

Backup blobs in R2 remain decryptable — they are encrypted against `AGE_RECIPIENT`'s keypair, not the `secrets.env.age` passphrase. Losing only the deploy passphrase does not cost backup recoverability.

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
sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh down
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main
```

## Failure modes

| Symptom                                | Cause                                               | Fix                                                                                   |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `git checkout` fails                   | Uncommitted changes in working tree                 | `git status`, reset or stash                                                          |
| `git checkout landed at X, expected Y` | Post-checkout SHA assertion                         | Inspect `git status`, clean up                                                        |
| `age: failed to read identity`         | Wrong passphrase                                    | Retry; verify against password manager after 3 attempts                               |
| `docker pull` unauthorized             | GHCR PAT expired                                    | `docker login ghcr.io` as `deploy` with fresh PAT                                     |
| Smoke test timeout (60s)               | App container failed or `/api/health` returning 503 | `pm-compose.sh logs app db storage`                                                   |
| `no such container` on exec            | `docker compose up -d` did not start `app`          | `pm-compose.sh ps`; confirm the resolved tag exists in GHCR (wrapper pins it to HEAD) |
| `APP_IMAGE_TAG must be set`            | Manual `docker compose` invoked without the wrapper | Use `scripts/ops/pm-compose.sh` — it pins `APP_IMAGE_TAG` from the current `HEAD`.    |
