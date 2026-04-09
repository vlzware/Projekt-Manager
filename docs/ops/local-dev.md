# Local Development — Cheatsheet

Running Projekt-Manager on your own machine for rapid iteration. This is **not** a production stack — no Caddy, no TLS, plain HTTP on loopback. See `server-setup.md` for production.

## Why no local HTTPS

`http://localhost` is a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) per W3C spec — browsers treat loopback as trustworthy because the traffic never leaves the machine. `src/server/config/index.ts` sets `cookieSecure: process.env.NODE_ENV === 'production'`, so in dev the session cookie has no `Secure` flag and works fine over HTTP. Caddy stays out of the local path entirely. Production enforces HTTPS through a separate compose path (see [ADR-0008](../adr/0008-vpn-first-network-access.md)).

## Prerequisites

- **Node** pinned in `.nvmrc` (currently 22.20.0) — run `nvm install` in the repo root
- **Docker** + **Docker Compose** plugin — same pinned versions as production (see [ADR-0009](../adr/0009-pin-docker-versions-across-environments.md))
- Free ports: `3000` (Fastify), `5173` (Vite), `5432` (Postgres), `9000`/`9001` (MinIO)

## First-time setup

```bash
nvm install
npm install

cp .env.example .env

# One manual edit: STORAGE_ENDPOINT — the .env.example default is the
# Docker-network hostname "storage". When running the app via `npm run dev`
# on the host, it needs to be the published port instead.
sed -i 's|http://storage:9000|http://localhost:9000|' .env
```

Everything else in `.env.example` is dev-ready out of the box: `NODE_ENV=development`, `SEED=true` (creates the seed users on first start), `DOMAIN=localhost`, no Cloudflare token needed, no `BOOTSTRAP_ADMIN_*` needed.

## Every-day flow

```bash
# Start backing services (Postgres + MinIO) — no Caddy, no app container
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db storage storage-init

# Run Vite (HMR) + Fastify (tsx watch) in one terminal
npm run dev
```

Open `http://localhost:5173` in a browser. Log in with any seed user:

| Username     | Role       | Password   |
| ------------ | ---------- | ---------- |
| `inhaber`    | owner      | `changeme` |
| `buero`      | office     | `changeme` |
| `arbeiter1`  | worker     | `changeme` |
| `buchhalter` | bookkeeper | `changeme` |

Vite proxies `/api/*` → `http://localhost:3000`, Fastify connects to Postgres on `localhost:5432` and MinIO on `localhost:9000`. Editing any file on either side hot-reloads.

## Stop / reset

```bash
# Stop the containers, keep the data volumes
docker compose -f docker-compose.yml -f docker-compose.dev.yml down

# Wipe the database and MinIO bucket (fresh start — seed re-runs on next start)
docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v
```

## Re-seed without dropping the volume

Set `SEED=force` in `.env`, restart `npm run dev`. This does a `TRUNCATE ... CASCADE` before re-inserting. `SEED=true` alone skips seeding when the `users` table is non-empty.

## Running tests

```bash
# Unit + component + integration (requires db + storage up via the commands above)
npm test

# Coverage report
npm run test:coverage

# Watch mode during TDD
npm run test:watch

# End-to-end (Playwright)
npm run test:e2e
```

The integration tests connect to the same Postgres the dev server uses. They wipe and re-seed per test file — do not run them against a database you care about.

## Common pitfalls

- **Port already in use on `5432`.** A system Postgres is running. Either stop it (`sudo systemctl stop postgresql`) or change the exposed port in `docker-compose.dev.yml`.
- **`getaddrinfo EAI_AGAIN storage`** when running tests. You forgot the `STORAGE_ENDPOINT` edit in `.env`. Set it to `http://localhost:9000`.
- **Login rejected with "Anmeldung fehlgeschlagen."** on a fresh dev DB. Either `SEED` is `false`, or the seed failed silently. Check `npm run dev` output for seed errors; try `SEED=force` and restart.
- **`@fastify/helmet` HSTS complaining in the browser devtools.** Expected in dev — helmet still emits HSTS headers, but browsers ignore HSTS on `http://localhost`. Safe to ignore.
- **"Do not run the production `docker-compose.yml` with `DOMAIN=prmng.org` locally."** Caddy will successfully mint a real Let's Encrypt cert for `prmng.org` via Cloudflare DNS-01, burning one of the 5-per-week rate-limit slots. Your browser won't even reach the local Caddy (DNS routes `prmng.org` to the WireGuard IP), so the cert is wasted. If you need to test the full prod stack locally, do it against a throwaway domain you control, or use the iteration branch → CD → test-server path.

## Files involved

| Path                                            | Purpose                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `package.json` scripts                          | `dev`, `dev:client`, `dev:server`, `test`, `build`          |
| `docker-compose.yml` + `docker-compose.dev.yml` | Backing services (db + MinIO)                               |
| `vite.config.ts`                                | `/api` proxy to Fastify                                     |
| `src/server/start.ts`                           | Fastify entry point (dev and prod)                          |
| `src/server/seed.ts`                            | Seed data — dev only, guarded against `NODE_ENV=production` |
| `.env` (gitignored)                             | Local config — copied from `.env.example`                   |

## When you need the production stack

Don't try to reproduce it locally. Push to an `iteration/**` branch, let CI build and publish the image to GHCR, then the operator pulls it onto `prmng.org` over WireGuard via `scripts/deploy.sh` (see [`manual-deploy.md`](manual-deploy.md) for the full flow). Test through the WireGuard tunnel. Server setup reference: [`server-setup.md`](server-setup.md).
