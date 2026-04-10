# DNS Setup

Conventional deploys point the domain's A record at the server's public IP. This project does the opposite: the A record points to `10.213.17.1` -- the WireGuard interface IP. Only clients on the WireGuard tunnel can route to that address. That is the access control.

## Prerequisites

- Cloudflare account managing the domain's DNS zone
- A scoped API token: **Zone:DNS:Edit** + **Zone:Zone:Read** on the single zone (same token used by Caddy for DNS-01 ACME -- see Caddyfile)

## Procedure

### 1. Create the A record

| Field | Value |
|---|---|
| Type | A |
| Name | `@` (or subdomain) |
| Content | `10.213.17.1` |
| Proxy status | **DNS only** (grey cloud -- orange cloud OFF) |
| TTL | Auto (or 1 minute for initial testing) |

### 2. Why DNS only (no Cloudflare proxy)

- Cloudflare proxy terminates TLS at their edge. ADR-0008 rejects this -- TLS must terminate at Caddy.
- Cloudflare proxy cannot reach a private IP anyway. Proxied requests would fail.

## Cloudflare API token scope

The token serves double duty: Caddy uses it for DNS-01 ACME challenges, and it is the same credential you use to manage the zone.

| Permission | Purpose |
|---|---|
| Zone:DNS:Edit | Write `_acme-challenge` TXT records (Caddy) and manage A records |
| Zone:Zone:Read | Let the API resolve the zone ID from the domain name |

**Zone resources:** restrict to the single managed zone.

Never use the Global API Key. Store the token in your password manager and in `secrets.env.age` per [manual-deploy.md](manual-deploy.md).

## Verification

From a WireGuard-connected client:

```bash
dig +short <domain>
# expect: 10.213.17.1

curl -v https://<domain>/api/health
# expect: 200 OK, valid TLS
```

From outside the VPN:

```bash
dig +short <domain>
# still returns 10.213.17.1 (public DNS resolves it -- the IP is just unreachable)

curl --connect-timeout 5 https://<domain>/api/health
# expect: timeout (cannot route to 10.213.17.1)
```

## References

- [ADR-0008 -- VPN-first network access](../adr/0008-vpn-first-network-access.md)
- [wireguard-setup.md](wireguard-setup.md)
- [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md)
