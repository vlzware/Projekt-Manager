# ADR-0008: VPN-first network access — Tailscale for pilot deployment

- **Status:** Accepted (amended 2026-04-07)
- **Date:** 2026-04-06
- **Amended:** 2026-04-07 — see [Amendments](#amendments)

## Context

ADR-0003 assumes Caddy terminates TLS via Let's Encrypt, which requires a domain that resolves to the server. No domain has been purchased, and buying one solely for a pilot demo is unjustified overhead.

Additionally, the codebase is largely AI-assisted and has not undergone the hardening expected of a public-facing web application. Exposing it to the open internet during the pilot phase introduces unnecessary risk. The pilot audience is small and controlled — approximately five users who can tolerate a one-time VPN client install.

Key forces:

- **Attack surface reduction.** Fewer publicly exposed ports means fewer vectors to defend. Only SSH (22/TCP) and WireGuard (41641/UDP for Tailscale) need to be reachable.
- **No domain dependency at decision time.** Unblocks deployment while a domain and ACME configuration are set up as a follow-up; does not defer the TLS requirement itself.
- **Pilot friction budget.** A one-time Tailscale install per user is acceptable for a B2B demo. A browser TLS warning (self-signed cert) would not be.
- **Reversibility.** Adding a domain and enabling Caddy's auto-HTTPS later is a configuration change, not an architecture change.

## Decision

We will use Tailscale (a managed WireGuard-based VPN) as the sole access method for the pilot deployment. The application will only be reachable through the Tailscale network — no public HTTP/HTTPS ports will be opened.

Caddy remains in the stack as a reverse proxy and **terminates TLS regardless of VPN status**. Defense in depth requires every layer to encrypt independently: the VPN restricts *who* can reach the server, TLS protects *what* they transmit once they do. The two are additive, never substitutes. Once a domain is acquired, Caddy obtains a real Let's Encrypt certificate via DNS-01 ACME so that no public ports are required — see #47 for the implementation.

Tailscale's free tier (3 users, 100 devices) covers the pilot. Tailscale clients are available via the iOS App Store, Google Play Store, and native packages for macOS, Windows, and Linux — no sideloading required.

If user count exceeds the free tier, the migration path is:

- **Headscale** — an open-source, self-hosted Tailscale-compatible control server. It runs as a single binary or Docker container and can be deployed on the same VPS alongside the application stack. The existing Tailscale clients continue working unchanged — they are reconfigured to point to the self-hosted Headscale coordination server instead of Tailscale's. The switch requires updating each client's control server URL, not reinstalling.
- **Tailscale paid plan** — $6/user/month, no infrastructure changes.

## Alternatives Considered

### Public HTTPS with a purchased domain

Caddy auto-provisions Let's Encrypt certificates, the app is publicly reachable. Main advantage: zero client-side setup for users. Ruled out because it exposes an unhardened application to the internet and requires purchasing and maintaining a domain before the product has validated with even one customer.

### Raw WireGuard (self-managed)

Full control, no external dependency. Main advantage: no reliance on Tailscale's coordination server. Ruled out for the pilot because it adds operational burden (manual key generation, config file distribution, NAT traversal configuration) that Tailscale handles automatically. The onboarding experience for pilot users — importing a config file vs. installing an app and accepting an invite — favors Tailscale at this stage.

### Self-signed certificates on public IP

No domain, no VPN — just HTTPS with a self-signed cert. Ruled out because browsers display prominent security warnings that undermine trust in a product demo. Instructing pilot users to bypass certificate warnings is unprofessional and trains bad security habits.

## Consequences

### Positive

- Attack surface reduced to two ports (SSH + WireGuard) — no web-facing exposure
- No domain purchase or DNS management required during pilot
- Pilot users get a native app experience (Tailscale client) rather than browser certificate warnings
- Future removal of the VPN gate (once the application has been hardened for public exposure) requires only firewall rule changes — TLS, certificate provisioning, and HSTS are already in place

### Negative

- Every pilot user must install the Tailscale client (~5 min one-time setup)
- Dependency on Tailscale's proprietary coordination server for key exchange and peer discovery (data plane remains peer-to-peer)
- Free tier limited to 3 users — exceeding this requires paid Tailscale or migration to Headscale
- Tailnet routing for the domain must be configured (Tailscale DNS override or subnet routing) so that `prmng.org` resolves to the server's tailnet-reachable interface — an operational step that would not exist with public DNS and public HTTPS

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [ADR-0005: Session management — HttpOnly cookies](0005-session-management-httponly-cookies.md) — `Secure` flag requires TLS in all deployments
- [docs/ops/server-setup.md](../ops/server-setup.md) — current server configuration and firewall rules

## Amendments

### 2026-04-07 — Remove HTTPS-deferral slip

Earlier revisions of this ADR framed TLS as "not needed inside the VPN" (claiming WireGuard made in-transit security a non-concern regardless of Caddy's TLS configuration) and authorised a `tls internal` stopgap until a domain was purchased. Both framings are wrong and violate defense in depth: the VPN restricts *who* can reach the server, TLS protects *what* they send; they are independent controls and neither substitutes for the other.

Sections amended: Context (key forces), Decision, Positive consequences, Negative consequences.

The decision itself is unchanged: Tailscale remains the sole access method for pilot deployment, and no public ports are opened. The correction is to the rationale around TLS, not to the access-gate decision.

Implementation follow-through is tracked by #47: replace the current HTTP-only Caddy config with Let's Encrypt via DNS-01 ACME (Cloudflare provider), remove the HTTP listener entirely, and verify the full auth flow end-to-end over HTTPS.
