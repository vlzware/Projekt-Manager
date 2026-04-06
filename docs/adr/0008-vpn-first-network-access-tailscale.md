# ADR-0008: VPN-first network access — Tailscale for pilot deployment

- **Status:** Accepted
- **Date:** 2026-04-06
- **Confidence:** High

## Context

ADR-0003 assumes Caddy terminates TLS via Let's Encrypt, which requires a domain that resolves to the server. No domain has been purchased, and buying one solely for a pilot demo is unjustified overhead.

Additionally, the codebase is largely AI-assisted and has not undergone the hardening expected of a public-facing web application. Exposing it to the open internet during the pilot phase introduces unnecessary risk. The pilot audience is small and controlled — approximately five users who can tolerate a one-time VPN client install.

Key forces:

- **Attack surface reduction.** Fewer publicly exposed ports means fewer vectors to defend. Only SSH (22/TCP) and WireGuard (41641/UDP for Tailscale) need to be reachable.
- **No domain dependency.** Eliminates the HTTPS/certificate question entirely for the pilot phase.
- **Pilot friction budget.** A one-time Tailscale install per user is acceptable for a B2B demo. A browser TLS warning (self-signed cert) would not be.
- **Reversibility.** Adding a domain and enabling Caddy's auto-HTTPS later is a configuration change, not an architecture change.

## Decision

We will use Tailscale (a managed WireGuard-based VPN) as the sole access method for the pilot deployment. The application will only be reachable through the Tailscale network — no public HTTP/HTTPS ports will be opened.

Caddy remains in the stack as a reverse proxy (routing requests to the application, serving static assets) but does not terminate TLS during the pilot phase. When a domain is acquired for broader deployment, Caddy's auto-HTTPS can be re-enabled with a configuration change.

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
- WireGuard encryption covers all traffic, making in-transit security a non-concern regardless of Caddy's TLS configuration
- Migration to public HTTPS is a config change (add domain, enable Caddy auto-HTTPS, open ports 80/443) — no application code changes

### Negative

- Every pilot user must install the Tailscale client (~5 min one-time setup)
- Dependency on Tailscale's proprietary coordination server for key exchange and peer discovery (data plane remains peer-to-peer)
- Free tier limited to 3 users — exceeding this requires paid Tailscale or migration to Headscale
- The deployment is not representative of eventual public-facing production — integration testing of HTTPS, CORS, and cookie security attributes (`Secure` flag) is deferred

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [ADR-0005: Session management — HttpOnly cookies](0005-session-management-httponly-cookies.md) — `Secure` flag behavior deferred until HTTPS is enabled
- [docs/ops/server-setup.md](../ops/server-setup.md) — current server configuration and firewall rules
