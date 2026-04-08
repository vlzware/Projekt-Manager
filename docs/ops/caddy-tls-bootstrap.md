# Caddy TLS bootstrap procedure

How to obtain the first Let's Encrypt certificate for a new deployment without burning Let's Encrypt production rate limits during debugging.

## Default behavior (no bootstrap needed)

The committed `Caddyfile` does **not** specify an `acme_ca` or `tls { ca ... }` directive, which means Caddy uses **Let's Encrypt production** by default. For an established, working setup, deploy the committed Caddyfile and Caddy will obtain a real certificate on first start. No bootstrap procedure needed.

The procedure below applies in **two specific situations**:

1. **First-time setup of a new domain** — the DNS-01 challenge path has not been proven to work yet. A typo in the Cloudflare API token scope, a wrong DNS record, or a misconfigured firewall will fail the challenge, and each failure burns LE production rate limit.
2. **Major change to the ACME flow** — new DNS provider, new token, new domain — anything that could cause the first few attempts to fail.

## Why use Let's Encrypt staging first

LE production has rate limits designed to protect their infrastructure (current values per [letsencrypt.org/docs/rate-limits/](https://letsencrypt.org/docs/rate-limits/)):

- **50 certs per registered domain per 7 days.** A "registered domain" is the public-suffix-aware base domain — `prmng.org`, not `www.prmng.org` or `api.prmng.org`. They all share the same quota.
- **5 failed validations per identifier per account per hour.** Five misconfigured DNS-01 attempts in an hour and you are locked out for an hour.
- **300 new orders per account per 3 hours.**
- **Duplicate Certificates per Registered Domain: 5 per 7 days** — a "duplicate" is a cert with the exact same set of hostnames.

These exist for good reasons but they make debugging expensive. Hit the per-hour lockout twice in a debugging session and half a day is gone.

LE operates a **staging environment** at `https://acme-staging-v02.api.letsencrypt.org/directory` with:

- **Effectively unlimited rate limits** for development use (subject to change without notice — staging is not an SLA target)
- A **separate CA hierarchy** — certs are issued by `(STAGING) Let's Encrypt` / "Fake LE" intermediates, deliberately **not in any browser or OS trust store**
- **Separate ACME accounts** from production — a staging account is unrelated to a production account, even if registered with the same email

Everything else — the ACME protocol, the DNS-01 challenge mechanics, the cert issuance flow — is identical to production. So if it works in staging, it will work in production.

## Bootstrap procedure (the safe way)

### Step 1 — Edit Caddyfile to point at staging

Edit `Caddyfile` and add a `ca` line inside the `tls { ... }` block:

```caddyfile
{$DOMAIN:localhost} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
		ca https://acme-staging-v02.api.letsencrypt.org/directory   # ← bootstrap only
	}
	# ... rest of config
}
```

This is a temporary edit. Either commit it on a throwaway branch or just edit the file on the server directly — it will be removed in step 4.

### Step 2 — Recreate the Caddy container

```bash
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml up -d --force-recreate caddy
```

**Use `--force-recreate`, not `restart`** — see the [container restart gotcha](#the-container-restart-gotcha) below for why this matters.

### Step 3 — Verify the staging cert

Watch the logs for a successful obtain:

```bash
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml logs caddy --since 1m -f
```

Look for the success line:

```
"trying to solve challenge","identifier":"<domain>","challenge_type":"dns-01"
"authorization finalized","authz_status":"valid"
"certificate obtained successfully","issuer":"acme-staging-v02.api.letsencrypt.org-directory"
```

`Ctrl-C` once the success line appears.

Then test the TLS handshake from a WireGuard client. **Note the `-k`** — staging certs are not in any trust store, so `curl` verification will fail without it:

```bash
curl -vk --resolve "<domain>:443:10.213.17.1" "https://<domain>/api/health"
```

Expect: TLS handshake completes, the application's response body returns. Optionally inspect the cert to confirm it's the staging issuer:

```bash
echo | openssl s_client -connect 10.213.17.1:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

The issuer should mention `STAGING` or `Fake LE`.

### Step 4 — Edit Caddyfile back to production

Remove the `ca https://acme-staging-v02...` line you added in Step 1. The `tls` block should once again be:

```caddyfile
tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}
```

### Step 5 — Recreate the Caddy container again

```bash
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml up -d --force-recreate caddy
```

### Step 6 — Verify the production cert

Same log incantation as Step 3. The success line should now show:

```
"certificate obtained successfully","issuer":"acme-v02.api.letsencrypt.org-directory"
```

(Note: **no** `staging` in the path.)

Test again, this time **without** `-k`:

```bash
curl -v --resolve "<domain>:443:10.213.17.1" "https://<domain>/api/health"
```

Expect: clean TLS handshake, no warnings, 200 OK with the application's response. The cert chain validates against the standard CA bundle.

If the public DNS A record for `<domain>` is also pointed at `10.213.17.1` (the WireGuard interface address — see ADR-0008), you can drop the `--resolve` and use plain `curl https://<domain>/api/health`.

## Direct-to-production (alternative)

For an experienced operator with a known-working configuration — same DNS provider, same token scope, same domain — you can skip staging entirely. Just deploy with the committed Caddyfile (no `ca` directive, defaults to production) and watch the logs. If anything goes wrong, you will see it in the first attempt and can fix it before burning through the rate limit.

Don't do this for a brand-new domain or a brand-new Cloudflare token — too easy to waste your daily quota debugging a typo.

## The container restart gotcha

This burned an afternoon during the iteration-4 bootstrap. Three `docker compose` commands look similar but do very different things:

| Command | What it does |
|---|---|
| `docker compose restart caddy` | Sends SIGTERM to the **existing** caddy container. The container's environment variables and bind mounts are **not re-evaluated**. Changes to `.env` are invisible. |
| `docker compose up -d caddy` | Reads `.env` and the compose file, computes the desired container config, **compares against the running container**. If anything differs, recreates the container. If nothing differs, no-op. |
| `docker compose up -d --force-recreate caddy` | Same as above but **always** recreates the container, even if compose thinks nothing has changed. |

**Use `--force-recreate` whenever you have edited the Caddyfile.** The Caddyfile is bind-mounted, not part of the compose config hash, so a plain `up -d` will see "nothing changed" and refuse to act. The hot file change won't take effect until the next forced recreate.

**Use `up -d` (without `--force-recreate`) when you have edited `.env` or `docker-compose.yml`.** Compose will detect the diff and recreate the container with the new env vars.

**Never use `restart` after editing `.env`** — your changes will be silently ignored.

## Cert storage layout

Caddy persists ACME state under the `caddy_data` Docker volume, mounted at `/data` inside the container. The relevant paths:

```
/data/caddy/
├── acme/
│   ├── acme-staging-v02.api.letsencrypt.org-directory/
│   │   └── users/default/
│   │       ├── default.key       ← LE staging account private key
│   │       └── default.json
│   └── acme-v02.api.letsencrypt.org-directory/
│       └── users/default/
│           ├── default.key       ← LE production account private key
│           └── default.json
└── certificates/
    ├── acme-staging-v02.api.letsencrypt.org-directory/
    │   └── <domain>/
    │       ├── <domain>.crt      ← staging cert (untrusted by browsers)
    │       ├── <domain>.key
    │       └── <domain>.json
    └── acme-v02.api.letsencrypt.org-directory/
        └── <domain>/
            ├── <domain>.crt      ← production cert (the real one)
            ├── <domain>.key
            └── <domain>.json
```

Storage is **per-CA**. The staging cert and the production cert can coexist without conflict. When Caddy is configured for production, it looks in the production directory for an existing cert; when configured for staging, it looks in the staging directory. This is also why a leftover staging cert does not break a production deployment — Caddy doesn't read it when configured for production.

## Forcing re-issuance

If a deployed cert is broken or compromised, force Caddy to obtain a fresh one by deleting the cert files from the running issuer's directory:

```bash
sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml exec caddy \
  rm -rf /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<domain>

sudo -u deploy docker compose -f /opt/projekt-manager/docker-compose.yml up -d --force-recreate caddy
```

Caddy will detect the missing cert on next startup and obtain a new one immediately. **Beware the rate limit** — the "5 failures per identifier per account per hour" cap applies; do not loop on this.

The ACME account key in `acme/<issuer>/users/default/` should normally **not** be deleted. If you delete it, Caddy registers a new account on next start, which is harmless but consumes a slot in the "10 new accounts per IP per 3 hours" quota.

## Verifying which certificate is in use

From any host that can reach the deployment over the WireGuard tunnel:

```bash
echo | openssl s_client -connect 10.213.17.1:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

A production cert shows an issuer like `C = US, O = Let's Encrypt, CN = E8` (or another current LE intermediate). A staging cert shows an issuer mentioning `STAGING` or `Fake`.
