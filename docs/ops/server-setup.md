# Server Setup — Hetzner VPS

Provisioned: 2026-04-06

## Server

- **Provider:** Hetzner Cloud
- **OS:** Ubuntu 24.04.4 LTS
- **Tier:** CX23 (2 vCPU / 4 GB RAM / 40 GB disk)
- **Firewall:** Hetzner Cloud Firewall (external, not ufw)

## Accounts

| Account | Purpose | SSH key | sudo | docker |
|---------|---------|---------|------|--------|
| `root` | Disabled for SSH | — | — | — |
| Admin user | Interactive admin | Personal key (`authorized_keys`) | Yes (password required) | No |
| `deploy` | CI/CD (GitHub Actions) | Dedicated key (`projekt-manager-deploy`) | No | Yes |

- Admin username and credentials stored in password manager, not in this repo
- `deploy` is a system account (`--system`), no password set
- Deploy private key stored in GitHub Secrets (`DEPLOY_KEY`)
- Deploy git access via read-only GitHub Deploy Key (separate keypair at `/home/deploy/.ssh/github_deploy`)

## SSH Hardening

- `PermitRootLogin no`
- `PasswordAuthentication no`
- Key-only authentication for all accounts
- fail2ban active on sshd (5 attempts / 10 min window / 1 hour ban)

## Firewall Rules (Hetzner Cloud Firewall)

| Port | Protocol | Status | Purpose |
|------|----------|--------|---------|
| 22 | TCP | Open | SSH (admin + CI/CD) |
| 80 | TCP | Closed | HTTP — open when domain acquired (ACME challenge + redirect) |
| 443 | TCP | Closed | HTTPS — open when domain acquired |

All other inbound traffic is blocked. Application access is via Tailscale VPN only (see ADR-0008).

Tailscale uses WireGuard (UDP/41641 by default), but relies on NAT traversal — no inbound firewall rule is needed. The coordination server brokers the connection; the data plane is peer-to-peer after handshake.

## Automatic Maintenance

- `unattended-upgrades` enabled for security patches

## Network Access

- **VPN:** Tailscale (WireGuard-based) — see ADR-0008
- **Application URL (target state):** `https://prmng.org`, resolved to the server's tailnet interface via Tailscale DNS override or subnet routing
- **Caddy:** Reverse proxy with TLS termination via Let's Encrypt, using DNS-01 ACME through the Cloudflare provider (no public ACME port required)
- Pilot users must install the Tailscale client and join the tailnet to access the app
- **HTTPS is mandatory** in every deployment — TLS for `Secure` cookies and HSTS is a baseline security requirement and is not substituted by the VPN. Defense in depth: VPN and TLS are independent controls.
- **Current deployment state (as of 2026-04-07):** the test server still serves plain HTTP — this is broken, blocks pilot use, and is tracked by #47. No pilot users should be onboarded until this is fixed.

## Software Installed

- Docker Engine (official repo, not Ubuntu package)
- Docker Compose plugin
- Tailscale
- fail2ban

## Key File Locations

| What | Where |
|------|-------|
| Project directory | `/opt/projekt-manager` |
| Production environment | `/opt/projekt-manager/.env` (not in repo) |
| Deploy authorized_keys | `/home/deploy/.ssh/authorized_keys` |
| Deploy GitHub key | `/home/deploy/.ssh/github_deploy` |
| Deploy SSH config | `/home/deploy/.ssh/config` |
| fail2ban SSH config | `/etc/fail2ban/jail.local` |

## Setup Steps (recreatable)

This guide provisions a VPS from scratch. Each phase builds on the previous one.

**Golden rule:** always verify access in a second terminal before changing authentication. Locking yourself out of a headless server means reprovisioning from zero.

### Prerequisites

Before starting you need:

- A Hetzner Cloud account
- An ED25519 SSH keypair on your local machine
- Access to the GitHub repo settings (for deploy keys and secrets)
- Access to the team password manager (for storing server credentials)

### Phase 1 — Base OS

**Goal:** Fresh server with a non-root admin account.

**Why a separate admin user:** Root should never be used for interactive sessions. A named admin account provides audit trail (who did what), sudo requires re-authentication, and disabling root SSH later doesn't lock you out.

1. Create VPS in Hetzner Cloud: Ubuntu 24.04, CX23, add your SSH key during creation.
2. Configure Hetzner Cloud Firewall: allow 22/TCP inbound, block everything else.
3. SSH in as root:

```bash
apt update && apt upgrade -y && reboot
```

4. After reboot, create the admin user:

```bash
adduser <admin-username>
usermod -aG sudo <admin-username>
```

5. Copy your SSH key to the admin user:

```bash
mkdir -p /home/<admin-username>/.ssh
cp /root/.ssh/authorized_keys /home/<admin-username>/.ssh/authorized_keys
chown -R <admin-username>:<admin-username> /home/<admin-username>/.ssh
chmod 700 /home/<admin-username>/.ssh
chmod 600 /home/<admin-username>/.ssh/authorized_keys
```

**Verify:** in a new terminal, `ssh <admin-username>@<ip>` works and `sudo whoami` returns `root`. Do not proceed until this works.

### Phase 2 — SSH hardening

**Goal:** Eliminate password-based and root login.

**Why sed instead of sshd_config.d:** Ubuntu 24.04 supports drop-in configs in `/etc/ssh/sshd_config.d/`, but the main config file may have conflicting directives (uncommented defaults). `sed` ensures the exact state regardless of the initial file. Alternatively, drop a file into `sshd_config.d/` and verify no conflicts with `sshd -T | grep -E 'permitrootlogin|passwordauthentication'`.

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload sshd
```

**Verify:** `ssh root@<ip>` is rejected. Admin key-based login still works.

### Phase 3 — Deploy user

**Goal:** A least-privilege account that CI/CD uses to deploy. Never has admin access.

**Why a system account:** `--system` creates a user with no password, no aging, and a UID below 1000 — conventional for service accounts. It cannot log in interactively unless explicitly given a shell (we give `/bin/bash` because git and docker compose need it).

1. On the **server**:

```bash
sudo adduser --system --group --shell /bin/bash --home /home/deploy deploy
```

2. On your **local machine** — generate a dedicated SSH key (no passphrase):

```bash
ssh-keygen -t ed25519 -C "deploy@projekt-manager" -f ~/.ssh/projekt-manager-deploy
```

3. On the **server** — install the public key:

```bash
sudo mkdir -p /home/deploy/.ssh
sudo tee /home/deploy/.ssh/authorized_keys <<< "$(cat)"  # paste the .pub content, then Ctrl+D
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

**Verify:** `ssh -i ~/.ssh/projekt-manager-deploy deploy@<ip>` connects. `sudo whoami` fails with "deploy is not in the sudoers file."

### Phase 4 — Docker

**Goal:** Container runtime for the application stack.

**Why the official Docker repo:** Ubuntu's `docker.io` package lags behind on security patches and does not include the Compose V2 plugin. The official repo uses `signed-by` APT pinning — the GPG key (`docker.asc`) is bound to this specific repository, preventing it from being used to sign packages from other sources.

**Why pinned versions:** Docker Engine and Compose plugin versions are pinned across every host (local dev, VPS) and placed on apt hold. This prevents silent drift from `apt upgrade` / `unattended-upgrades` and keeps `docker compose` behaviour deterministic between local and production. See [ADR-0009](../adr/0009-pin-docker-versions-across-environments.md) for the full decision and upgrade procedure.

**Pinned versions (current):**

| Package | Version |
|---|---|
| `docker-ce` | `5:29.3.1-1~ubuntu.24.04~noble` |
| `docker-ce-cli` | `5:29.3.1-1~ubuntu.24.04~noble` |
| `containerd.io` | `2.2.2-1~ubuntu.24.04~noble` |
| `docker-buildx-plugin` | `0.33.0-1~ubuntu.24.04~noble` |
| `docker-compose-plugin` | `5.1.1-1~ubuntu.24.04~noble` |

Add the Docker apt repository:

```bash
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

Install the pinned versions explicitly (not `apt-get install docker-ce` — that grabs latest):

```bash
sudo apt-get install -y \
  docker-ce=5:29.3.1-1~ubuntu.24.04~noble \
  docker-ce-cli=5:29.3.1-1~ubuntu.24.04~noble \
  containerd.io=2.2.2-1~ubuntu.24.04~noble \
  docker-buildx-plugin=0.33.0-1~ubuntu.24.04~noble \
  docker-compose-plugin=5.1.1-1~ubuntu.24.04~noble
sudo usermod -aG docker deploy
```

Hold the versions so future `apt upgrade` cannot bump them:

```bash
sudo apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**Verify:**

```bash
docker --version                  # expect: Docker version 29.3.1
docker compose version            # expect: Docker Compose version v5.1.1
apt-mark showhold                 # expect: all five packages listed
```

Then `ssh -i ~/.ssh/projekt-manager-deploy deploy@<ip>` and `docker ps` — should return an empty table (not "permission denied").

**Upgrading later:** Do not bump Docker casually. Follow the lockstep procedure in ADR-0009 — unhold, install the new explicit version on a non-production host first, smoke test, repeat on remaining hosts (VPS last), then update both the ADR and the version table above.

**Note:** Docker group membership grants effective root access on the host (a known Docker design decision). The deploy user can escalate via `docker run -v /:/host ...`. This is tracked as a hardening item in #48.

### Phase 5 — Brute-force protection

**Goal:** Rate-limit SSH login attempts to reduce noise and waste attacker resources.

**Why these parameters:** 5 retries in a 10-minute window triggers a 1-hour ban. With key-only auth, brute force is already futile — fail2ban's value is reducing log noise and making automated scanning unprofitable. These are conservative defaults; tighten `maxretry` if log volume warrants it.

```bash
sudo apt-get install -y fail2ban
sudo tee /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
port = ssh
filter = sshd
maxretry = 5
bantime = 3600
findtime = 600
EOF
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

Unattended security upgrades are pre-enabled on Ubuntu 24.04. Confirm:

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades  # select Yes
```

**Verify:** `sudo fail2ban-client status sshd` shows the jail is active with 0 currently banned.

### Phase 6 — Tailscale VPN

**Goal:** Encrypted access to the application without exposing ports publicly.

**Why Tailscale:** See ADR-0008 for the full decision record. Short version: WireGuard encryption, zero-config NAT traversal, app store clients for pilot users, migration path to self-hosted Headscale.

**Install via APT** (preferred over curl-pipe-sh — uses package signature verification):

```bash
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | \
  sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | \
  sudo tee /etc/apt/sources.list.d/tailscale.list
sudo apt-get update
sudo apt-get install -y tailscale
sudo tailscale up   # opens auth URL — approve in browser
```

**Verify:** `tailscale ip -4` returns a `100.x.y.z` address. From your local machine (with Tailscale running): `ping <tailscale-ip>` succeeds.

### Phase 7 — Git access for deploy user

**Goal:** The deploy user can pull from the private repo. Read-only.

**Why a separate keypair:** The deploy user has two SSH keys serving different purposes: one for CI to reach the server (Phase 3), one for the server to reach GitHub (this phase). Separate keys mean rotating one doesn't affect the other, and the GitHub key is read-only by design.

1. Generate a keypair on the server:

```bash
sudo -u deploy ssh-keygen -t ed25519 -C "deploy-git@projekt-manager" \
  -f /home/deploy/.ssh/github_deploy -N ""
```

2. Configure the deploy user's SSH to use this key for GitHub:

```bash
sudo tee /home/deploy/.ssh/config << 'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
sudo chown deploy:deploy /home/deploy/.ssh/config
sudo chmod 600 /home/deploy/.ssh/config
```

3. Add the public key as a **read-only** Deploy Key on GitHub (Repo > Settings > Deploy keys). Leave "Allow write access" unchecked.

```bash
sudo cat /home/deploy/.ssh/github_deploy.pub
```

**Verify:** `sudo -u deploy ssh -T git@github.com` prints "successfully authenticated" (exit code 1 is normal — GitHub closes the session).

### Phase 8 — Application

**Goal:** Running application stack with production credentials.

1. Create the project directory and clone:

```bash
sudo mkdir -p /opt/projekt-manager
sudo chown deploy:deploy /opt/projekt-manager
sudo -u deploy git clone <repo-ssh-url> /opt/projekt-manager
```

2. Create the production `.env` file. Generate each password independently:

```bash
sudo -u deploy cp /opt/projekt-manager/.env.example /opt/projekt-manager/.env
```

Edit `/opt/projekt-manager/.env` and set these values:

| Variable | What to set | Notes |
|----------|-------------|-------|
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` | Unique generated password |
| `DATABASE_URL` | `postgresql://pm:<password>@db:5432/projekt_manager` | Same password as above |
| `MINIO_ROOT_USER` | A username you choose | MinIO admin account |
| `MINIO_ROOT_PASSWORD` | `openssl rand -base64 24` | Unique generated password |
| `STORAGE_ACCESS_KEY` | Same value as `MINIO_ROOT_USER` | The app connects to MinIO using the root credentials |
| `STORAGE_SECRET_KEY` | Same value as `MINIO_ROOT_PASSWORD` | Same credentials, different variable name |
| `DOMAIN` | Tailscale IP or domain when available | Caddy uses this for TLS certificate provisioning |
| `NODE_ENV` | `production` | Enables security checks, disables seeding |
| `SEED` | `false` | Never seed in production |

3. Start the stack:

```bash
sudo -u deploy bash -c 'cd /opt/projekt-manager && docker compose up -d'
```

**Verify:** `sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml ps` shows all containers as "healthy" or "running". `curl -k https://localhost/api/health` returns `{"status":"ok"}`.

### Phase 9 — GitHub Secrets and CD

**Goal:** GitHub Actions can deploy automatically after CI passes.

Add three repository secrets at Repo > Settings > Secrets and variables > Actions:

| Secret | Value | Why |
|--------|-------|-----|
| `DEPLOY_HOST` | Server **public** IP | GitHub runners cannot join the tailnet — SSH must use the public IP |
| `DEPLOY_USER` | `deploy` | The least-privilege account from Phase 3 |
| `DEPLOY_KEY` | Contents of `~/.ssh/projekt-manager-deploy` (private key) | The key generated in Phase 3, on your local machine |

**Verify:**

```bash
# Push a commit to an iteration branch — CI should pass, deploy should trigger
gh run list --workflow=Deploy --limit 3

# From local machine via Tailscale
curl -k https://<tailscale-ip>/api/health

# From local machine via public IP — should timeout (firewall blocks it)
curl --connect-timeout 5 https://<public-ip>/api/health
```
