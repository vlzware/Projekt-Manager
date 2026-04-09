# Server Setup — Hetzner VPS

Provisioned: 2026-04-06

> **Note — 2026-04-10:** The CI/CD auto-deploy path was replaced with a manual pull-based deploy in [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md). Phase 9 below has been rewritten for the new flow. Phase 3 step (3) — the `authorized_keys`-for-GHA install — is obsolete; skip it for a new provisioning. Day-to-day deploy operations now live in [`manual-deploy.md`](manual-deploy.md).

## Server

- **Provider:** Hetzner Cloud
- **OS:** Ubuntu 24.04.4 LTS
- **Tier:** CX23 (2 vCPU / 4 GB RAM / 40 GB disk)
- **Firewall:** Hetzner Cloud Firewall (external, not ufw)

## Accounts

| Account    | Purpose                                                                                                             | SSH key                                    | sudo                    | docker |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------- | ------ |
| `root`     | Disabled for SSH                                                                                                    | —                                          | —                       | —      |
| Admin user | Interactive admin                                                                                                   | Personal key (`authorized_keys`)           | Yes (password required) | No     |
| `deploy`   | Container ops (local `sudo -u deploy` only, see [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)) | None — `/usr/sbin/nologin`, no inbound SSH | No                      | Yes    |

- Admin username and credentials stored in password manager, not in this repo
- `deploy` is a system account (`--system`), no password set
- After the ADR-0012 cutover: `deploy` has no inbound SSH path. Shell is `/usr/sbin/nologin`, `~deploy/.ssh/authorized_keys` is removed. The account is invoked only via `sudo -u deploy` from an operator's existing sudo session.
- Deploy git access via read-only GitHub Deploy Key (outbound-only keypair at `/home/deploy/.ssh/github_deploy`), used by `scripts/deploy.sh` for `git fetch origin`. Untouched by the cutover.

## SSH Hardening

- `PermitRootLogin no`
- `PasswordAuthentication no`
- Key-only authentication for all accounts
- fail2ban active on sshd (5 attempts / 10 min window / 1 hour ban)

## Firewall Rules (Hetzner Cloud Firewall)

| Port  | Protocol | Status | Purpose                                                |
| ----- | -------- | ------ | ------------------------------------------------------ |
| 22    | TCP      | Open   | SSH (admin only; CI/CD SSH path removed per ADR-0012)  |
| 51820 | UDP      | Open   | WireGuard                                              |
| 80    | TCP      | Closed | (Not opened — DNS-01 ACME does not need it)            |
| 443   | TCP      | Closed | (Not opened — Caddy binds only to the `wg0` interface) |

All other inbound traffic is blocked. Application access is via WireGuard VPN only (see [ADR-0008](../adr/0008-vpn-first-network-access.md)).

WireGuard listens on UDP/51820. The Hetzner Cloud Firewall must allow inbound UDP/51820 from any source. WireGuard is stealth by default — it returns no response to unauthenticated packets, so the open port is not detectable to an unauthenticated portscan without a valid peer private key.

## Automatic Maintenance

- `unattended-upgrades` enabled for security patches

## Network Access

- **VPN:** plain WireGuard (Linux kernel module) — see [ADR-0008](../adr/0008-vpn-first-network-access.md)
- **Tunnel subnet:** `10.213.0.0/22` allocated, `10.213.17.0/24` routed initially. Server interface `wg0` at `10.213.17.1/32`. Peers at `10.213.17.10` and up.
- **Application URL (target state):** `https://${DOMAIN}`, served by Caddy bound only to `wg0` (`10.213.17.1:443`). Clients reach the application by joining the WireGuard network and resolving `${DOMAIN}` to `10.213.17.1` (initially via `--resolve` or hosts override; future iterations may add internal DNS).
- **Caddy:** custom `xcaddy` build (see `docker/caddy/Dockerfile`) with the `caddy-dns/cloudflare` plugin pinned to a specific git SHA. TLS termination via Let's Encrypt using DNS-01 ACME through the Cloudflare provider — no public ACME port required.
- **Onboarding:** users install the official WireGuard client and import a per-peer config file (server-side keygen, distributed via Signal or in-person; never email).
- **HTTPS is mandatory** in every deployment regardless of VPN status — TLS for `Secure` cookies and HSTS is a baseline security requirement and is not substituted by the VPN. Defense in depth: VPN and TLS are independent controls.

## Software Installed

- Docker Engine (official repo, not Ubuntu package)
- Docker Compose plugin
- WireGuard (`wireguard-tools` from Ubuntu apt; kernel module is already in the mainline kernel)
- `qrencode` (for peer QR generation)
- fail2ban

## Key File Locations

| What                         | Where                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Project directory            | `/opt/projekt-manager`                                                                                             |
| Non-secret env vars          | `/opt/projekt-manager/.env` (not in repo)                                                                          |
| Encrypted runtime secrets    | `/opt/projekt-manager/secrets.env.age` (age-encrypted, see [manual-deploy.md § Secrets](manual-deploy.md#secrets)) |
| Deploy GitHub key (outbound) | `/home/deploy/.ssh/github_deploy`                                                                                  |
| Deploy SSH config            | `/home/deploy/.ssh/config`                                                                                         |
| fail2ban SSH config          | `/etc/fail2ban/jail.local`                                                                                         |

## Setup Steps (recreatable)

This guide provisions a VPS from scratch. Each phase builds on the previous one.

**Golden rule:** always verify access in a second terminal before changing authentication. Locking yourself out of a headless server means reprovisioning from zero.

### Prerequisites

Before starting you need:

- A Hetzner Cloud account
- An ED25519 SSH keypair on your local machine
- Access to the GitHub repo settings (for the Deploy Key used in Phase 7)
- Access to the team password manager (for storing server credentials, the age passphrase, and the GHCR PAT)

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

**Goal:** A least-privilege account that owns the production stack. Never has admin access, never logs in interactively.

**Why a system account:** `--system` creates a user with no password, no aging, and a UID below 1000 — conventional for service accounts. Shell is `/usr/sbin/nologin`: `sudo -u deploy <cmd>` works regardless (it runs the command directly, not via the user's shell), and denying an interactive shell removes an entire class of misuse.

> **Note — ADR-0012:** Steps 2 and 3 below install an inbound SSH key (the former `DEPLOY_KEY` for GitHub Actions). That path was removed in the 2026-04-10 cutover. **For a new provisioning, skip steps 2 and 3.** Keep only step 1, then proceed to Phase 4. The manual deploy flow is set up in Phase 9 and documented in [manual-deploy.md](manual-deploy.md).

1. On the **server**:

```bash
sudo adduser --system --group --shell /usr/sbin/nologin --home /home/deploy deploy
sudo mkdir -p /home/deploy/.ssh
sudo chown deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
```

2. _(Obsolete after ADR-0012 — skip for new provisioning.)_ On your **local machine** — generate a dedicated SSH key (no passphrase):

```bash
ssh-keygen -t ed25519 -C "deploy@projekt-manager" -f ~/.ssh/projekt-manager-deploy
```

3. _(Obsolete after ADR-0012 — skip for new provisioning.)_ On the **server** — install the public key:

```bash
sudo tee /home/deploy/.ssh/authorized_keys <<< "$(cat)"  # paste the .pub content, then Ctrl+D
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

**Verify:** `sudo -u deploy whoami` prints `deploy`. `sudo -u deploy sudo whoami` fails with "deploy is not in the sudoers file."

### Phase 4 — Docker

**Goal:** Container runtime for the application stack.

**Why the official Docker repo:** Ubuntu's `docker.io` package lags behind on security patches and does not include the Compose V2 plugin. The official repo uses `signed-by` APT pinning — the GPG key (`docker.asc`) is bound to this specific repository, preventing it from being used to sign packages from other sources.

**Why pinned versions:** Docker Engine and Compose plugin versions are pinned across every host (local dev, VPS) and placed on apt hold. This prevents silent drift from `apt upgrade` / `unattended-upgrades` and keeps `docker compose` behaviour deterministic between local and production. See [ADR-0009](../adr/0009-pin-docker-versions-across-environments.md) for the full decision and upgrade procedure.

**Pinned versions (current):**

| Package                 | Version                         |
| ----------------------- | ------------------------------- |
| `docker-ce`             | `5:29.3.1-1~ubuntu.24.04~noble` |
| `docker-ce-cli`         | `5:29.3.1-1~ubuntu.24.04~noble` |
| `containerd.io`         | `2.2.2-1~ubuntu.24.04~noble`    |
| `docker-buildx-plugin`  | `0.33.0-1~ubuntu.24.04~noble`   |
| `docker-compose-plugin` | `5.1.1-1~ubuntu.24.04~noble`    |

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

Then `sudo -u deploy docker ps` — should return an empty table (not "permission denied").

**Upgrading later:** Do not bump Docker casually. Follow the lockstep procedure in ADR-0009 — unhold, install the new explicit version on a non-production host first, smoke test, repeat on remaining hosts (VPS last), then update both the ADR and the version table above.

**Note:** Docker group membership grants effective root access on the host (a known Docker design decision). The deploy user can escalate via `docker run -v /:/host ...`. Treat the ability to invoke `sudo -u deploy` as a root-equivalent privilege until this is mitigated. The ADR-0012 cutover removed the remote trust link that handed this privilege out (the former `DEPLOY_KEY`), but the posture itself is unchanged. Research and resolution tracked in #72; see also [ADR-0012 § Negative / residual risks](../adr/0012-manual-pull-based-deploy-over-wireguard.md#negative--residual-risks).

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

### Phase 6 — WireGuard VPN

**Goal:** Encrypted access to the application without exposing HTTP/HTTPS ports publicly.

**Why plain WireGuard:** See [ADR-0008](../adr/0008-vpn-first-network-access.md) for the full decision. Short version: audited protocol, mainlined Linux kernel module, no third-party control plane, official Android client is open-source and actively maintained.

**Why a systemd drop-in for Docker:** `docker.service` and `wg-quick@wg0.service` are independent siblings under `multi-user.target` with no inherent ordering. On a cold boot, Docker can start before `wg0` exists; Caddy's `${WG_BIND_IP}:443:443` port publish then fails with `EADDRNOTAVAIL` and the container restart-loops. The drop-in declares `Requires=` + `After=` so Docker waits for the WireGuard interface to come up.

1. Install WireGuard userspace tools (kernel module is already in the mainline kernel):

   ```bash
   sudo apt-get install -y wireguard-tools qrencode
   ```

2. Generate the server keypair:

   ```bash
   sudo mkdir -p /etc/wireguard
   cd /etc/wireguard
   sudo sh -c 'umask 077 && wg genkey | tee server.privkey | wg pubkey > server.pubkey'
   sudo chmod 600 server.privkey
   ```

3. Create `wg0.conf` with no peers (peers are added in Phase 6.1):

   ```bash
   sudo tee /etc/wireguard/wg0.conf > /dev/null <<EOF
   [Interface]
   Address    = 10.213.17.1/24
   ListenPort = 51820
   PrivateKey = $(sudo cat /etc/wireguard/server.privkey)

   # Peers added one block per pilot user — see Phase 6.1
   EOF
   sudo chmod 600 /etc/wireguard/wg0.conf
   ```

4. Install the systemd drop-in that orders Docker after `wg-quick@wg0`:

   ```bash
   sudo mkdir -p /etc/systemd/system/docker.service.d
   sudo tee /etc/systemd/system/docker.service.d/wait-for-wireguard.conf > /dev/null <<'EOF'
   [Unit]
   Requires=wg-quick@wg0.service
   After=wg-quick@wg0.service
   EOF
   sudo systemctl daemon-reload
   ```

5. Enable and start the WireGuard interface:

   ```bash
   sudo systemctl enable --now wg-quick@wg0.service
   ```

6. Open UDP/51820 in the Hetzner Cloud Firewall (Cloud Console or `hcloud firewall add-rule ...`).

**Verify** (run all four):

```bash
# Interface is up with the expected address
ip -4 addr show wg0
# expect: inet 10.213.17.1/24

# Service is active
systemctl is-active wg-quick@wg0.service
# expect: active

# Drop-in ordering is in effect — BOTH commands must return a non-empty match
systemctl list-dependencies docker.service | grep -F wg-quick@wg0.service
systemctl list-dependencies --reverse wg-quick@wg0.service | grep -F docker.service

# WireGuard is listening on UDP/51820
sudo ss -ulnp | grep -F :51820
```

### Phase 6.1 — Pilot peer onboarding

**Goal:** Add a WireGuard peer for each user. Per [ADR-0008](../adr/0008-vpn-first-network-access.md), peer keys are generated server-side; only the rendered config or QR code is distributed, via Signal or in-person — never email.

For each user, on the server:

```bash
PEER_NAME="<user-device>"          # e.g. vladimir-pixel
PEER_IP="10.213.17.10"             # next /32 from 10.213.17.10+
SERVER_PUB=$(sudo cat /etc/wireguard/server.pubkey)
SERVER_ENDPOINT="<server-public-ip>:51820"

sudo mkdir -p /etc/wireguard/peers
cd /etc/wireguard
sudo sh -c "umask 077 && wg genkey | tee peers/${PEER_NAME}.privkey | wg pubkey > peers/${PEER_NAME}.pubkey"

# Append the peer to wg0.conf
sudo tee -a /etc/wireguard/wg0.conf > /dev/null <<EOF

# ${PEER_NAME} added $(date -I)
[Peer]
PublicKey  = $(sudo cat peers/${PEER_NAME}.pubkey)
AllowedIPs = ${PEER_IP}/32
EOF

# Reload wg0 with the new peer — no interface restart, no Caddy restart
sudo wg syncconf wg0 <(sudo wg-quick strip wg0)

# Generate the per-peer client config (this is the file the user imports)
sudo tee peers/${PEER_NAME}.conf > /dev/null <<EOF
[Interface]
PrivateKey = $(sudo cat peers/${PEER_NAME}.privkey)
Address    = ${PEER_IP}/32

[Peer]
PublicKey           = ${SERVER_PUB}
Endpoint            = ${SERVER_ENDPOINT}
AllowedIPs          = 10.213.17.0/24
PersistentKeepalive = 25
EOF

# Render as QR code for in-person Android scanning
sudo qrencode -t ansiutf8 < peers/${PEER_NAME}.conf
```

After the user reports "connected" on their device, verify the handshake on the server:

```bash
sudo wg show wg0 latest-handshakes | grep -F "$(sudo cat /etc/wireguard/peers/${PEER_NAME}.pubkey)"
# expect: a Unix timestamp within the last 30 seconds
```

If no handshake appears within ~5 minutes, the import did not work — revoke the peer (remove its `[Peer]` block from `wg0.conf`, re-run `wg syncconf wg0 <(wg-quick strip wg0)`), regenerate, and retry.

After successful handshake, securely delete the per-peer scratch files containing the private key:

```bash
sudo shred -u /etc/wireguard/peers/${PEER_NAME}.conf
sudo shred -u /etc/wireguard/peers/${PEER_NAME}.privkey
```

Keep `peers/${PEER_NAME}.pubkey` for audit trail.

### Phase 7 — Git access for deploy user

**Goal:** The deploy user can pull from the private repo. Read-only.

**Why a Deploy Key:** The deploy user needs read-only access to pull the private repo. A dedicated, read-only GitHub Deploy Key scoped to this single repository is the narrowest credential that satisfies the requirement — a personal access token would carry user-wide scope, and making the repo public is a separate decision (gated on the Dockerfile audit for any public flip). This is an **outbound** key — server to GitHub. It is unaffected by the ADR-0012 cutover, which removed only the _inbound_ (GHA → VPS) SSH path.

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

2. Create the production `.env` file (non-secret variables only; secrets move to `secrets.env.age` in Phase 9):

```bash
sudo -u deploy cp /opt/projekt-manager/.env.example /opt/projekt-manager/.env
```

Edit `/opt/projekt-manager/.env` and set these values. The four secrets marked **[secret]** must **not** live in `.env` after the cutover — they go in `/opt/projekt-manager/secrets.env.age` (see Phase 9 and [manual-deploy.md § Secrets](manual-deploy.md#secrets)). They are listed here only to show how they are generated.

| Variable                       | What to set                                                    | Notes                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`            | `openssl rand -base64 24`                                      | **[secret]** → `secrets.env.age`                                                                                                      |
| `DATABASE_URL`                 | `postgresql://pm:${POSTGRES_PASSWORD}@db:5432/projekt_manager` | Non-secret; `docker-compose.yml` composes it from `POSTGRES_PASSWORD` at runtime                                                      |
| `MINIO_ROOT_USER`              | A username you choose                                          | MinIO admin account (non-secret username)                                                                                             |
| `MINIO_ROOT_PASSWORD`          | `openssl rand -base64 24`                                      | **[secret]** → `secrets.env.age`                                                                                                      |
| `STORAGE_ACCESS_KEY`           | Same value as `MINIO_ROOT_USER`                                | Non-secret                                                                                                                            |
| `STORAGE_SECRET_KEY`           | Same value as `MINIO_ROOT_PASSWORD`                            | **[secret]** → `secrets.env.age`                                                                                                      |
| `DOMAIN`                       | Fully qualified domain for Caddy / TLS                         | Caddy uses this for TLS certificate provisioning                                                                                      |
| `CLOUDFLARE_API_TOKEN`         | Scoped Cloudflare API token                                    | **[secret]** → `secrets.env.age`. Permissions: `Zone:Zone:Read` + `Zone:DNS:Edit` on the single managed zone. NOT the Global API Key. |
| `WG_BIND_IP`                   | `10.213.17.1`                                                  | WireGuard server interface address. Caddy publishes `:443` only on this host IP.                                                      |
| `NODE_ENV`                     | `production`                                                   | Enables security checks, disables seeding                                                                                             |
| `SEED`                         | `false`                                                        | Never seed in production                                                                                                              |
| `BOOTSTRAP_ADMIN_USERNAME`     | Strong admin username                                          | First-deploy only — see Phase 8.1. Leave unset on subsequent deploys.                                                                 |
| `BOOTSTRAP_ADMIN_PASSWORD`     | `openssl rand -base64 24`                                      | First-deploy only — see Phase 8.1. Must pass the standard password policy.                                                            |
| `BOOTSTRAP_ADMIN_DISPLAY_NAME` | Human-readable name (optional)                                 | First-deploy only — defaults to the username if unset.                                                                                |

After the ADR-0012 cutover, `.env` must not contain the four `[secret]` rows above; they live only in `secrets.env.age`. Use Phase 9 to build the encrypted file, then remove the plaintext secret lines from `.env`.

3. Complete Phase 9 to build `secrets.env.age`, then start the stack via the deploy script:

```bash
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main
```

**Verify:** `sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml ps` shows all containers as "healthy" or "running". To probe the app stack directly, bypassing Caddy:

```bash
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
  exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"
```

Caddy is bound only to `${WG_BIND_IP}:443` (the WireGuard interface), so `curl https://localhost/api/health` from the server will not work — that is expected. The full TLS chain is verified from a WireGuard client in Phase 9.

### Phase 8.1 — First-login ritual (one-time, first deploy only)

**Goal:** Create the first admin account and scrub the bootstrap credentials from disk.

**Why this phase exists:** Seeding is a development fixture and is deliberately skipped when `NODE_ENV=production` (`src/server/start.ts`). A fresh production database is schema-migrated but empty, so nothing can authenticate. On the very first deploy, the application's startup hook reads `BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD`/`BOOTSTRAP_ADMIN_DISPLAY_NAME` from `.env`, inserts exactly one `owner`-role user, emits a loud warning log, and on every subsequent start it is a no-op because the `users` table is no longer empty. See [ADR-0010](../adr/0010-first-run-admin-bootstrap.md).

**When this phase runs:** Exactly once, on the first deploy of a fresh `pgdata` volume. Re-run only if the `pgdata` volume has been rebuilt from scratch (e.g. a restore-from-backup that chose not to preserve the users table).

**Golden rule:** the bootstrap values sit in `/opt/projekt-manager/.env` in plaintext during this phase. The window between step 3 (set) and step 7 (scrub) must be as short as operationally possible.

1. On the **server**, confirm the stack is running and healthy (Phase 8 verification above).

2. Verify the database is empty — the bootstrap only runs on an empty `users` table and this is the one time you want to see a zero:

   ```bash
   sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     exec -T db psql -U pm -d projekt_manager -c 'SELECT count(*) FROM users;'
   # expect: count = 0
   ```

3. Generate a strong password and set the bootstrap values in `.env`:

   ```bash
   openssl rand -base64 24          # copy the output
   sudo -u deploy nano /opt/projekt-manager/.env
   ```

   Set:

   ```env
   BOOTSTRAP_ADMIN_USERNAME=<choose a strong admin username>
   BOOTSTRAP_ADMIN_PASSWORD=<paste the openssl output>
   BOOTSTRAP_ADMIN_DISPLAY_NAME=<your real name, optional>
   ```

   Password policy: ≥8 characters, ≤72 UTF-8 bytes, not in the common-password blocklist (`src/server/data/common-passwords.ts`). A half-configured pair (only one of the two) will refuse to start the service.

4. Restart the `app` container so it re-reads `.env`:

   ```bash
   sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     up -d --force-recreate app
   ```

5. Verify the bootstrap fired by tailing the app logs:

   ```bash
   sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     logs app --tail=30 | grep -F 'Bootstrap admin user'
   # expect: one line naming your BOOTSTRAP_ADMIN_USERNAME and instructing you to
   # change the password and remove the env vars.
   ```

6. From a WireGuard client, open `https://${DOMAIN}` in a browser. Log in with the bootstrap credentials to confirm authentication works end-to-end.

   **Immediately after logging in succeeds**, change the password. This iteration has no change-password UI (out of scope for the walking skeleton — see `docs/spec/index.md` §4.5), so the rotation is done via `curl` against the change-password endpoint. From the same WireGuard client:

   ```bash
   # Generate the replacement password first so the window is minimal.
   NEW_PW="$(openssl rand -base64 24)"
   echo "$NEW_PW"                 # write it down / paste into password manager NOW

   # Log in to obtain a session cookie.
   curl -sS -c /tmp/pm-rotate-cookies.txt \
     -H 'Content-Type: application/json' \
     -d "{\"username\":\"<BOOTSTRAP_ADMIN_USERNAME>\",\"password\":\"<BOOTSTRAP_ADMIN_PASSWORD>\"}" \
     "https://${DOMAIN}/api/auth/login"
   # expect: {"user":{...}} and a session cookie in /tmp/pm-rotate-cookies.txt

   # Rotate the password.
   curl -sS -b /tmp/pm-rotate-cookies.txt \
     -H 'Content-Type: application/json' \
     -d "{\"currentPassword\":\"<BOOTSTRAP_ADMIN_PASSWORD>\",\"newPassword\":\"${NEW_PW}\"}" \
     "https://${DOMAIN}/api/auth/change-password"
   # expect: {"success":true}

   # Clean up the cookie jar — it carries a valid session.
   shred -u /tmp/pm-rotate-cookies.txt
   ```

   Then in the browser, refresh the page, log out, and log back in with the new password to confirm the rotation took effect.

7. Back on the **server**, scrub the three bootstrap vars from `.env`:

   ```bash
   sudo -u deploy nano /opt/projekt-manager/.env
   ```

   Delete (or comment out) the `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`, and `BOOTSTRAP_ADMIN_DISPLAY_NAME` lines.

8. Restart the `app` container again to confirm the bootstrap hook is a no-op once users exist:

   ```bash
   sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     up -d --force-recreate app
   sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml \
     logs app --tail=30 | grep -F 'Bootstrap admin user' || echo 'ok — no bootstrap warning'
   # expect: no match on the second restart.
   ```

9. Confirm the account is still usable by logging in from a WireGuard client with the password you set in step 6. Bootstrap phase complete.

**If something goes wrong:**

- **"BOOTSTRAP_ADMIN_PASSWORD is required" on startup**: only one of the two vars is set. Fix the `.env` and restart.
- **"BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters" or "…must not exceed 72 bytes"**: the password fails the policy. Generate a new one.
- **"BOOTSTRAP_ADMIN_PASSWORD is in the common-password blocklist"**: pick a less common password. Do not work around the blocklist.
- **Bootstrap log says "user created" but login fails**: the browser may be holding a stale session. Clear cookies for `${DOMAIN}` and try again.
- **Database already has users but you want to start over**: this is a destructive operation — do not use the bootstrap for it. Manually reset with `psql` under explicit human control.

### Phase 9 — Manual deploy bootstrap

**Goal:** The operator can deploy via `scripts/deploy.sh` over WireGuard, with runtime secrets encrypted at rest and plaintext never touching the VPS disk.

This phase is a summary of [manual-deploy.md § Bootstrap](manual-deploy.md#bootstrap--first-run-on-a-freshly-cloned-vps). Refer to that section for the authoritative procedure and failure modes; what follows is the server-setup-specific subset.

**Rationale:** See [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md). The former push-based flow (`.github/workflows/deploy.yml` SSHing into the VPS as `deploy`) was removed because the SSH key it used was effectively a root credential, and LLM-assisted CD configuration could not be reliably audited (incident: #79).

1. **Install `age`** for secrets encryption:

```bash
sudo apt update && sudo apt install -y age
```

2. **Log the `deploy` user in to GHCR** so it can pull the app image. Use a classic GitHub PAT scoped `read:packages` only (generate at https://github.com/settings/tokens). Store the PAT in the password manager.

```bash
sudo -u deploy docker login ghcr.io -u vlzware --password-stdin <<< '<PAT>'
```

3. **Verify the pull works end-to-end**:

```bash
sudo -u deploy docker pull ghcr.io/vlzware/projekt-manager:main
```

4. **Create the encrypted secrets file** on your workstation and scp it to the VPS. Keep the passphrase in the password manager.

```bash
# Workstation:
cat > /tmp/secrets.env <<'EOF'
POSTGRES_PASSWORD='...'
MINIO_ROOT_PASSWORD='...'
STORAGE_SECRET_KEY='...'
CLOUDFLARE_API_TOKEN='...'
EOF
age -p -o secrets.env.age /tmp/secrets.env   # enter passphrase
shred -u /tmp/secrets.env

scp secrets.env.age deploy@vps:/tmp/secrets.env.age

# VPS (via sudo account):
sudo mv /tmp/secrets.env.age /opt/projekt-manager/secrets.env.age
sudo chown deploy:deploy /opt/projekt-manager/secrets.env.age
sudo chmod 0640 /opt/projekt-manager/secrets.env.age
```

5. **Remove the plaintext secrets from `.env`** — the four `[secret]` rows listed in Phase 8 must only exist in `secrets.env.age` going forward.

6. **Dry-run the deploy script**:

```bash
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main
```

Confirm: age prompts for the passphrase, the GHCR image pulls, `docker compose up -d` brings the stack up, the smoke test loop prints `Deploy verified — healthy at <sha>`.

7. **Lock down the `deploy` user's inbound SSH path** — only after step 6 succeeds. Removes the former GHA `authorized_keys` entry only; the outbound `github_deploy` key stays in place so future `git fetch origin` calls still work.

```bash
sudo usermod -s /usr/sbin/nologin deploy
sudo rm -f /home/deploy/.ssh/authorized_keys
```

8. **Prove the locked-down flow** end-to-end by tearing the stack down and bringing it back up via the script:

```bash
sudo -u deploy bash -c 'cd /opt/projekt-manager && docker compose down'
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main
```

**Verify from a WireGuard client** (your laptop, with the per-peer config imported and tunnel up):

```bash
curl -v --resolve "${DOMAIN}:443:10.213.17.1" "https://${DOMAIN}/api/health"
# expect: 200 OK with a real Let's Encrypt certificate
# (during initial bootstrap, see docs/ops/caddy-tls-bootstrap.md)
```

**Verify negative case** — from outside the VPN (any other machine), the app must be unreachable:

```bash
curl --connect-timeout 5 "https://<server-public-ip>/api/health"
# expect: timeout (port 443 is not bound on the public interface)
```
