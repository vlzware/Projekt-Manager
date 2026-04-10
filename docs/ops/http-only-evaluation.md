# HTTP-Only Evaluation

> **WARNING:** This mode disables TLS and removes the VPN perimeter.
> The app is exposed on the public internet. Login credentials and session cookies are sent in cleartext.
> **Never use this for real users or real data.**

## When to use

- Testing the app on a VPS before committing to a domain.
- Evaluating the deployment pipeline.
- Never for real users or real data.

## What it changes

| Concern | Standard (HTTPS) | HTTP evaluation |
|---|---|---|
| Caddy | Custom build with Cloudflare DNS plugin, port 443 | Stock Caddy, port 80 |
| TLS | Let's Encrypt via DNS-01 ACME | None |
| Cookie Secure flag | On (HTTPS required for login) | Off (`ALLOW_INSECURE_HTTP=true`) |
| Domain required | Yes | No |
| WireGuard required | Yes | No |
| Access control | VPN-only | No network perimeter (app-level auth remains) |

## Prerequisites

- A VPS with Docker and Compose (Phases 1-5 from [server-setup.md](server-setup.md))
- Deploy user and Git access (Phases 3, 7 from [server-setup.md](server-setup.md))
- Port 80/TCP open in Hetzner Cloud Firewall

## Setup

```bash
# 1. Create .env (only 3 vars needed)
cat > /opt/projekt-manager/.env << 'EOF'
POSTGRES_PASSWORD=<choose-a-password>
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=<choose-a-password>
EOF

# 2. Deploy
sudo -u deploy docker compose -f docker-compose.yml -f docker-compose.http.yml pull
sudo -u deploy docker compose -f docker-compose.yml -f docker-compose.http.yml up -d

# 3. Access
curl http://<server-public-ip>/api/health
# Open http://<server-public-ip> in a browser
```

Since there is no `secrets.env.age` and no `deploy.sh` in this flow, the operator sets
env vars directly in `.env` and runs compose manually. This is intentional -- the
evaluation path is simpler than the production path.

## Seeding test data

Add `SEED=true` to `.env` and restart. See README.md for seed users.

## Graduating to production

1. Get a domain and add it to Cloudflare
2. Set up WireGuard -- see [wireguard-setup.md](wireguard-setup.md)
3. Configure DNS (A record pointing to WG IP) -- see [dns-setup.md](dns-setup.md)
4. Set up proper `.env` from `.env.production.example`
5. Set up `secrets.env.age` -- see [manual-deploy.md](manual-deploy.md)
6. Bootstrap TLS -- see [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md)
7. Switch to standard compose: `docker compose up -d` (no HTTP override)
8. Close port 80/TCP in Hetzner Cloud Firewall

## Security implications

- **No TLS.** Login credentials (username + password) and session cookies are sent in cleartext. Anyone intercepting traffic can capture reusable credentials, not just sessions.
- **No VPN perimeter.** The standard deployment restricts network access to WireGuard peers. This mode exposes the app on the public internet. Application-level authentication still applies -- unauthenticated users see only the login page and health endpoint.
- **If you previously deployed with HTTPS**, browsers that received the HSTS header will refuse HTTP for up to 180 days. Use a different browser or clear HSTS state.
