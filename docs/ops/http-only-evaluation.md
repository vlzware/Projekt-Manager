# HTTP-Only Evaluation

> **WARNING:** No TLS. Login credentials and session cookies travel in cleartext.
> **Never use this for real users or real data.**

## Three ways to run

| | Local dev | Full stack (HTTP) | Full stack (HTTPS) |
|---|---|---|---|
| App | Node process (`npm run dev`) | Docker container | Docker container |
| Reverse proxy | None (Vite proxies `/api/*`) | Caddy on port 80 | Caddy on port 443 (TLS) |
| DB + storage | Docker | Docker | Docker |
| Domain | No | No | Yes |
| TLS | No (localhost = secure context) | No | Yes (DNS-01 ACME) |
| VPN | No | No | Yes (WireGuard) |
| Use case | Day-to-day development | Evaluate full stack | Production |

Setup for local dev: [local-dev.md](local-dev.md). Setup for production: [README § Production](../../README.md#production).

This document covers **full stack (HTTP)** -- the middle column.

## Quick start

```bash
# From a fresh clone:
cat > .env << 'EOF'
POSTGRES_PASSWORD=evaluationpw
MINIO_ROOT_USER=evaluationadmin
MINIO_ROOT_PASSWORD=evaluationpw
SEED=true
EOF

docker compose -f docker-compose.yml -f docker-compose.http.yml up -d

curl http://localhost/api/health
# Open http://localhost in a browser
```

The compose override (`docker-compose.http.yml`):
- Replaces the custom Caddy build with stock Caddy on port 80
- Sets `ALLOW_INSECURE_HTTP=true` so the cookie Secure flag is off
- Adds `build: .` so the app image is built from source when not available from GHCR

`docker-compose.yml` hardcodes DATABASE_URL, STORAGE_*, NODE_ENV, and PORT inside the container -- the `.env` above only needs credentials and seed preference.

Note: `MINIO_ROOT_USER` cannot be `minioadmin` -- the app rejects known dev defaults in production mode.

## Remote access

When running on a remote server, open port 80/TCP in ufw (`sudo ufw allow 80/tcp`) and any cloud firewall. Access via `http://<server-ip>` instead of `http://localhost`.

For VPS provisioning (OS hardening, Docker install), see [server-setup.md](server-setup.md).

## Seed users

All seed users share the password `changeme`. See [README](../../README.md#seed-data) for the full list.

## Stop / clean up

```bash
# Stop, keep data
docker compose -f docker-compose.yml -f docker-compose.http.yml down

# Wipe everything
docker compose -f docker-compose.yml -f docker-compose.http.yml down -v
```

## Graduating to production

1. Get a domain and add it to Cloudflare
2. Set up WireGuard -- [wireguard-setup.md](wireguard-setup.md)
3. Configure DNS -- [dns-setup.md](dns-setup.md)
4. Set up `.env` from `.env.production.example`
5. Set up `secrets.env.age` -- [manual-deploy.md](manual-deploy.md)
6. Bootstrap TLS -- [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md)
7. Switch to standard compose: `docker compose up -d`
8. Close port 80/TCP if opened (`sudo ufw delete allow 80/tcp` + cloud firewall)

## Security implications

- **No TLS.** Credentials and sessions travel in cleartext. On a network you don't fully control, assume everything is interceptable.
- **No VPN.** On a remote server, anyone who can reach the IP can reach the login page. Application-level auth is present, but the app is a walking skeleton -- it has not been hardened against all attack vectors. The production VPN exists for defense in depth, not just access control.
- **HSTS conflict.** If the same browser previously visited the HTTPS version, it may refuse HTTP for up to 180 days. Use a different browser or clear HSTS state.
