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
| 80 | TCP | Closed | HTTP — not needed while VPN-only (ADR-0008) |
| 443 | TCP | Closed | HTTPS — open when domain is acquired |

All other inbound traffic is blocked. Application access is via Tailscale VPN only (see ADR-0008).

## Automatic Maintenance

- `unattended-upgrades` enabled for security patches

## Network Access

- **VPN:** Tailscale (WireGuard-based) — see ADR-0008
- **Application URL:** `http://<tailscale-ip>` (HTTP only, encrypted by WireGuard tunnel)
- **Caddy:** Reverse proxy on port 80, `DOMAIN=:80` (no TLS — deferred until domain is acquired)
- Pilot users must install the Tailscale client and join the tailnet to access the app

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

Each step assumes the previous one succeeded. Always test access in a second terminal before locking down the current access method.

### Phase 1 — Base OS (as root)

```bash
# 1. Provision VPS with Ubuntu 24.04, add SSH key during creation
#    Configure Hetzner Cloud Firewall: allow 22/TCP inbound, block all else

# 2. SSH in as root, update and reboot
apt update && apt upgrade -y && reboot

# 3. Create admin user (use a strong password — needed for sudo)
adduser <admin-username>
usermod -aG sudo <admin-username>

# 4. Copy SSH key to admin user
mkdir -p /home/<admin-username>/.ssh
cp /root/.ssh/authorized_keys /home/<admin-username>/.ssh/authorized_keys
chown -R <admin-username>:<admin-username> /home/<admin-username>/.ssh
chmod 700 /home/<admin-username>/.ssh
chmod 600 /home/<admin-username>/.ssh/authorized_keys
```

**Checkpoint:** open a second terminal, verify `ssh <admin-username>@<ip>` and `sudo whoami` both work.

### Phase 2 — SSH hardening (as admin user)

```bash
# 5. Disable root login and password auth
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload sshd
```

**Checkpoint:** in a new terminal, verify `ssh root@<ip>` is rejected, admin login still works.

### Phase 3 — Deploy user (as admin user)

```bash
# 6. Create system user (no password, no sudo)
sudo adduser --system --group --shell /bin/bash --home /home/deploy deploy

# 7. Generate SSH key locally for deploy access (no passphrase)
#    On your LOCAL machine:
ssh-keygen -t ed25519 -C "deploy@projekt-manager" -f ~/.ssh/projekt-manager-deploy

# 8. Copy public key to server
#    On the SERVER (paste the .pub content):
sudo mkdir -p /home/deploy/.ssh
sudo tee /home/deploy/.ssh/authorized_keys <<< "<paste public key>"
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

**Checkpoint:** `ssh -i ~/.ssh/projekt-manager-deploy deploy@<ip>` works, `sudo whoami` fails.

### Phase 4 — Docker (as admin user)

```bash
# 9. Install Docker from official repo (not Ubuntu package)
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 10. Grant deploy user Docker access
sudo usermod -aG docker deploy
```

**Checkpoint:** `ssh -i ~/.ssh/projekt-manager-deploy deploy@<ip>` then `docker ps` returns empty table.

### Phase 5 — Security (as admin user)

```bash
# 11. fail2ban
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

# 12. Verify unattended-upgrades (pre-installed on Ubuntu 24.04)
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades  # select Yes
```

### Phase 6 — Tailscale VPN (as admin user)

```bash
# 13. Install and authenticate
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up   # opens auth URL — approve in browser

# 14. Note the Tailscale IP
tailscale ip -4
```

### Phase 7 — Git access for deploy user (as admin user)

```bash
# 15. Generate a keypair ON THE SERVER for GitHub access
sudo -u deploy ssh-keygen -t ed25519 -C "deploy-git@projekt-manager" \
  -f /home/deploy/.ssh/github_deploy -N ""

# 16. Configure deploy user to use this key for GitHub
sudo tee /home/deploy/.ssh/config << 'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
sudo chown deploy:deploy /home/deploy/.ssh/config
sudo chmod 600 /home/deploy/.ssh/config

# 17. Add the public key as a read-only Deploy Key on GitHub:
#     Repo → Settings → Deploy keys → Add deploy key
#     Title: "VPS deploy (read-only)", leave write access unchecked
sudo cat /home/deploy/.ssh/github_deploy.pub
```

### Phase 8 — Application (as admin user)

```bash
# 18. Clone repo and create production environment
sudo mkdir -p /opt/projekt-manager
sudo chown deploy:deploy /opt/projekt-manager
sudo -u deploy git clone git@github.com:vlzware/Projekt-Manager.git /opt/projekt-manager

# 19. Create .env from template (generate passwords with: openssl rand -base64 24)
sudo -u deploy cp /opt/projekt-manager/.env.example /opt/projekt-manager/.env
sudo -u deploy nano /opt/projekt-manager/.env
# Set: POSTGRES_PASSWORD, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD,
#       STORAGE_ACCESS_KEY=MINIO_ROOT_USER, STORAGE_SECRET_KEY=MINIO_ROOT_PASSWORD,
#       DATABASE_URL with the postgres password, DOMAIN=:80, NODE_ENV=production, SEED=false

# 20. Start the stack
sudo -u deploy bash -c 'cd /opt/projekt-manager && docker compose up -d'
```

### Phase 9 — GitHub Secrets and CD

Add three repository secrets at Repo → Settings → Secrets → Actions:

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | Server **public** IP (not Tailscale — GitHub runners can't join tailnet) |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KEY` | Contents of `~/.ssh/projekt-manager-deploy` (private key, from local machine) |

### Verification

```bash
# From local machine via Tailscale — should return {"status":"ok"}
curl http://<tailscale-ip>/api/health

# From local machine via public IP — should timeout
curl --connect-timeout 5 http://<public-ip>/api/health

# Push to iteration branch or main — CI should pass, deploy should trigger
gh run list --workflow=Deploy --limit 3
```
