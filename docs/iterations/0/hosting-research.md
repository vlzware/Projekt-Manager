# Hosting Research

Status: Researched 2026-04-02 (live pricing)

## Architecture: Separate App from Storage

- **Application** (Node.js backend + React SPA): small, lightweight — needs minimal resources
- **Binary files** (pictures, Aufmaß, documents): object storage (S3-compatible), scales independently
- **Frontend**: static files, served from CDN or same server

## Storage: Solved

**Hetzner Object Storage — EUR 6.49/mo for 1TB.** German company, German DCs (Falkenstein/Nuremberg), S3-compatible. Best combination of price, GDPR compliance, and capacity. No other option matches this.

Alternatives:
- Cloudflare R2: ~EUR 6.90/mo, zero egress fees, but US company (CLOUD Act risk)
- Backblaze B2: ~EUR 2.70/mo (cheapest), but EU = Amsterdam only, US company
- Wasabi: EUR 6.99/mo (1TB minimum), Frankfurt available, but 90-day minimum storage duration

## Application Hosting Options

| Option | Monthly | Ops Burden | GDPR | Node.js | Notes |
|--------|---------|------------|------|---------|-------|
| Hetzner VPS (CX22) + Coolify | EUR 3.79 | Low (2-4 hrs/mo) | Strongest (100% DE) | Yes | Cheapest, but needs someone who can SSH |
| Render Starter (Frankfurt) | ~EUR 12 | Zero | Good (Frankfurt DC) | Yes | Free static site hosting included |
| Render Standard (Frankfurt) | ~EUR 32 | Zero | Good (Frankfurt DC) | Yes | Production-grade (2GB RAM) |
| Supabase Pro (Frankfurt) | EUR 23 | Zero | Good (Frankfurt DC) | No (Edge Fns/Deno) | BaaS — DB + auth + storage included |
| IONOS Shared | EUR 6-16 | Zero | Strongest (100% DE) | No (PHP only) | Last resort — forces PHP + MySQL |

Disqualified:
- Railway: no Frankfurt region (Amsterdam only), weak GDPR
- Fly.io: self-managed Postgres = not zero-ops; managed Postgres = EUR 35/mo minimum

## Recommended Compositions (app + DB + storage)

### Option A: Budget zero-ops — Render Starter + Hetzner Storage
- Render Starter (Frankfurt): Node.js $7 + PostgreSQL $6 + Static site $0
- Hetzner Object Storage: EUR 6.49
- **Total: ~EUR 18/mo**
- Zero ops, Frankfurt DC, Node.js native

### Option B: Cheapest — Hetzner VPS + Coolify + Hetzner Storage
- Hetzner CX22: EUR 3.79 (app + DB on same server via Coolify)
- Hetzner Object Storage: EUR 6.49
- **Total: ~EUR 10/mo**
- Requires someone for initial setup + occasional maintenance

### Option C: Production zero-ops — Render Standard + Hetzner Storage
- Render Standard (Frankfurt): Node.js $25 + PostgreSQL $10 + Static site $0
- Hetzner Object Storage: EUR 6.49
- **Total: ~EUR 39/mo**
- True zero-ops, production-grade resources

## Open Questions

1. **Can anyone handle basic Linux admin?** Determines whether Option B is viable given "no sysadmin" in Kickoff scope.
2. **GDPR strictness**: Is "US company, data in Frankfurt" acceptable, or must the hosting company itself be EU-based?
3. **Custom Node.js vs. BaaS**: Supabase is powerful but constrains backend to Edge Functions (Deno), not Node.js.

## Note

The hosting decision does not block the walking skeleton (Iteration 1). The skeleton is a static SPA — served from localhost or any static host. Hosting becomes relevant in Iteration 2 when the backend arrives.

Sources: Railway, Render, Fly.io, Supabase, Hetzner, Cloudflare, Backblaze, Wasabi, IONOS pricing pages (April 2026).
