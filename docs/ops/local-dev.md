# Local Development

No Caddy, no TLS, plain HTTP on loopback. `http://localhost` is a W3C secure context -- session cookies work without `Secure` flag in dev.

## Prerequisites

- **Node 22.20.0** (pinned in `.nvmrc`) -- `nvm install`
- **Docker + Compose plugin**
- Free ports: `3000` (Fastify), `5173` (Vite), `5432` (Postgres), `9000`/`9001` (MinIO)

## First-time setup

```bash
nvm install
npm install
cp .env.example .env
```

The `.env.example` defaults are dev-ready: `NODE_ENV=development`, `SEED=true`, `DOMAIN=localhost`. No Cloudflare token or bootstrap vars needed.

## Daily workflow

```bash
# Start backing services (Postgres + MinIO)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db storage storage-init

# Run Vite (HMR) + Fastify (tsx watch)
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to `http://localhost:3000`.

### Seed users

| Username | Role | Password |
|---|---|---|
| `inhaber` | owner | `changeme` |
| `buero` | office | `changeme` |
| `arbeiter1` | worker | `changeme` |
| `buchhalter` | bookkeeper | `changeme` |

## Stop / reset

```bash
# Stop containers, keep data
docker compose -f docker-compose.yml -f docker-compose.dev.yml down

# Wipe everything (fresh start, seed re-runs on next start)
docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v
```

## Re-seed without volume wipe

Set `SEED=force` in `.env`, restart `npm run dev`. Does `TRUNCATE ... CASCADE` before re-inserting. `SEED=true` skips seeding when users exist.

## Tests

```bash
npm test                  # unit + component + integration (db + storage must be running)
npm run test:coverage     # with coverage
npm run test:watch        # watch mode
npm run test:e2e          # Playwright E2E
```

Integration tests wipe and re-seed per file -- do not run against a database you care about.

## Common pitfalls

| Symptom | Fix |
|---|---|
| Port `5432` already in use | Stop system Postgres (`sudo systemctl stop postgresql`) or change port in `docker-compose.dev.yml` |
| `getaddrinfo EAI_AGAIN storage` | Verify `.env` has `STORAGE_ENDPOINT=http://localhost:9000` (the default in `.env.example`). If you copied from `.env.production.example`, this var is missing — use `.env.example` for dev. |
| Login fails on fresh DB | Check `npm run dev` output for seed errors; try `SEED=force` |
| Do NOT run `docker-compose.yml` with `DOMAIN=<prod-domain>` locally | Caddy will mint a real LE cert, burning rate-limit slots uselessly |

## Deploying to a VPS

Local development does not require a VPS. When ready to deploy, see the [production quick start](../../README.md#production) for the full path, or [HTTP-only evaluation](http-only-evaluation.md) for a quick test without a domain.
