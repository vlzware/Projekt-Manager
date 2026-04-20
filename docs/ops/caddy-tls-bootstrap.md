# Caddy TLS Bootstrap

First-time Let's Encrypt certificate provisioning. Use this for new domains or new Cloudflare tokens to avoid burning LE production rate limits.

**When to use:** first-time domain setup, or after changing DNS provider / token / domain.
**When to skip:** established setup with a known-working config -- just deploy and Caddy uses LE production by default.

## Procedure

### 1. Edit Caddyfile -- point at LE staging

Add a `ca` line inside the `tls` block:

```caddyfile
{$DOMAIN:localhost} {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
        ca https://acme-staging-v02.api.letsencrypt.org/directory   # bootstrap only
    }
    # ...
}
```

### 2. Recreate Caddy

```bash
sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh up -d --force-recreate caddy
```

**Must use `--force-recreate`** -- Caddyfile is bind-mounted, not part of the compose config hash, so `up -d` alone sees "nothing changed."

### 3. Verify staging cert

```bash
# Watch logs for success
sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh logs caddy --since 1m -f
# Look for: "certificate obtained successfully","issuer":"acme-staging-v02..."

# Test TLS from a WireGuard client (-k required for staging certs)
curl -vk --resolve "<domain>:443:10.213.17.1" "https://<domain>/api/health"

# Inspect cert issuer (should mention STAGING or Fake LE)
echo | openssl s_client -connect 10.213.17.1:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

### 4. Switch to production

Remove the `ca https://acme-staging-v02...` line from the Caddyfile. The `tls` block should be:

```caddyfile
tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}
```

### 5. Recreate Caddy again

```bash
sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh up -d --force-recreate caddy
```

### 6. Verify production cert

```bash
# Watch logs -- success line should show acme-v02 (no "staging")
sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh logs caddy --since 1m -f

# Test WITHOUT -k (production cert validates against standard CA bundle)
curl -v --resolve "<domain>:443:10.213.17.1" "https://<domain>/api/health"
# Expect: 200 OK, clean TLS handshake, no warnings
```

## Container restart reference

| Command                                       | Behavior                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `docker compose restart caddy`                | SIGTERM only. `.env` and bind-mount changes **ignored**. Never use after editing `.env`.              |
| `docker compose up -d caddy`                  | Compares config hash. Recreates if `.env` or compose file changed. Does NOT detect Caddyfile changes. |
| `docker compose up -d --force-recreate caddy` | Always recreates. **Use after Caddyfile edits.**                                                      |

## Force re-issuance

If a cert is broken or compromised:

```bash
sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh exec caddy \
  rm -rf /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<domain>

sudo -u deploy /opt/projekt-manager/scripts/ops/pm-compose.sh up -d --force-recreate caddy
```

**Beware rate limits** -- 5 failed validations per identifier per account per hour.

Do NOT delete the ACME account key (`/data/caddy/acme/<issuer>/users/default/`) -- Caddy registers a new account otherwise, consuming a rate-limit slot.

## Verify current cert

```bash
echo | openssl s_client -connect 10.213.17.1:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

Production issuer: `C = US, O = Let's Encrypt, CN = E8` (or similar). Staging issuer mentions `STAGING` or `Fake`.
