# ADR-0008: VPN-first network access

- **Status:** Accepted
- **Date:** 2026-04-08

## Context

The application is LLM-generated and has not undergone independent security review. Exposing it directly to the public internet introduces risk that no configuration fix eliminates — a code-level hardening effort is required before direct exposure is safe. Until then, every access path to the application must traverse a trust wrapper whose own security story is strong enough to sit on the public internet in the application's place.

The trust wrapper's components must be auditable open-source with an active maintenance path. "Auditable" alone is not enough — an unmaintained codebase that once passed audit is a decaying foundation. "Maintained proprietary" is also not enough — an update we cannot inspect is an update we are trusting blindly.

## Decision

**VPN-first network access.** The application is reachable only through a VPN tunnel. No public HTTP/HTTPS ports are opened on the server's firewall. Public ports are limited to SSH (22/TCP) and WireGuard (51820/UDP).

**VPN implementation: plain WireGuard** (Linux kernel module, mainlined since kernel 5.6).

**TLS terminates at Caddy regardless of VPN status.** Defense in depth: the VPN restricts *who* can reach the server, TLS protects *what* they transmit once they do. The two are independent controls and neither substitutes for the other. Caddy obtains a real Let's Encrypt certificate via DNS-01 ACME using the Cloudflare provider, so no public port is required for certificate issuance.

**Client scope: Android and desktop Linux.** Android is the primary pilot client platform per the project kickoff. Desktop Linux is supported via the official WireGuard client. **iOS, macOS, and Windows are out of project scope** — the official `wireguard-apple` client has received no upstream commits since 2023-02-15 and the project classifies the repository as "complete" (feature-frozen). A frozen client has no patch path for a future CVE and is therefore not a viable trust foundation.

**Single-tenant by design.** If multi-tenancy becomes a product requirement, the answer is one WireGuard server per tenant — a second VPS with its own `wg0` instance, its own keys, and its own DNS name — not a retrofit of a shared subnet. Plain WireGuard provides no per-peer ACLs beyond `AllowedIPs` (ingress-only), and a shared subnet gives every peer L3 access to every other peer regardless of tenant.

### Network topology

- Subnet: `10.213.0.0/22` allocated, `10.213.17.0/24` routed initially
- Server interface `wg0` at `10.213.17.1/32`, brought up at boot via `wg-quick@wg0.service`
- Peers at `10.213.17.10` and up (one `/32` per peer)
- Caddy binds to `10.213.17.1:443` only — not to any other host interface
- `docker.service` is ordered after `wg-quick@wg0.service` via a systemd drop-in at `/etc/systemd/system/docker.service.d/wait-for-wireguard.conf` containing `Requires=wg-quick@wg0.service` and `After=wg-quick@wg0.service`. Without this, Docker and `wg-quick` are siblings under `multi-user.target` with no ordering guarantee, and Caddy can race ahead of the interface and fail to bind.

### Trust framing

Three layers, each evaluated independently:

- **Protocol.** The WireGuard protocol is audited. Multiple independent formal verifications cover the core cryptographic construction (Noise IK + Curve25519 + ChaCha20-Poly1305 + BLAKE2). Strong basis for trust.
- **Kernel module.** `wireguard-linux` is in mainline kernel since 5.6 and is reviewed through the kernel upstream process. Not a third-party audit, but a continuously-examined implementation with an active maintenance path and a fast security-patch pipeline via Ubuntu's kernel updates.
- **Client applications.** Open-source but not independently audited. Within this layer: `wireguard-android` is actively maintained, accepted as the pilot client. `wireguard-linux-tools` backs desktop Linux usage. `wireguard-apple` and `wireguard-windows` are out of project scope.

This framing is honest about a limitation: Tailscale's clients are also not independently audited, so the "audited clients" axis is not a differentiator. The actual differentiators between plain WireGuard and Tailscale are the client update path (Tailscale ships updates through proprietary app stores we do not review) and the control plane (Tailscale operates a coordination server we cannot inspect). Plain WireGuard has neither dependency.

## Alternatives considered

**Tailscale.** Rejected. The proprietary client update path and the proprietary coordination server together form a trust surface we cannot inspect or control. Convenient user onboarding (single sign-on, Magic DNS) is not enough to compensate for the loss of control over two production-critical components.

**Headscale.** Rejected for the same client reason as Tailscale. Headscale is a self-hosted, open-source coordination server for Tailscale clients — the server is auditable but the clients are still Tailscale's.

**Cloudflare Tunnel + Cloudflare Access.** Rejected. TLS terminates at Cloudflare's edge by design. The browser sees Cloudflare's certificate, not the application's; Cloudflare decrypts every request body, response, and cookie before re-encrypting to the origin. This directly contradicts the "TLS terminates at Caddy" principle regardless of the operational convenience the approach offers.

**Self-signed certificates / Caddy `tls internal`.** Rejected. Browser warnings on a product demo are unprofessional and train users to bypass certificate warnings — the opposite of the security posture the trust wrapper exists to support.

**OpenVPN, strongSwan (IPsec).** Rejected. Larger userspace attack surface, slower data plane, worse mobile onboarding story, and no advantage over plain WireGuard on any axis.

**Netbird.** Considered and noted as a possible future migration path if identity/SSO becomes a requirement, but rejected for this iteration on the grounds that the codebase is younger and has thinner audit history than plain WireGuard.

## Consequences

### Positive

- Protocol is audited, kernel module is mainlined and actively patched, Android client is actively maintained. All three pass the audited/maintained-open-source bar.
- Public attack surface is two ports (SSH + WireGuard). WireGuard is stealth by default: it returns no response to unauthenticated packets, so the service is not detectable to an unauthenticated port scan.
- TLS terminates at Caddy with a real Let's Encrypt certificate. `HSTS`, `Secure` cookies, and other browser security controls all work.
- Architecture is reversible. When the application is hardened enough for direct public exposure, removing the VPN gate requires only a firewall rule change and a Caddy bind update — not an architectural rewrite.

### Negative

- Apple platforms are unsupported.
- Plain WireGuard has no PKI and no revocation primitive. Removing a peer means editing `wg0.conf` and running `wg syncconf`.
- Peer management is manual at pilot scale. The in-house admin web app (tracked separately) automates this above the manual-edit scaling ceiling.
- Mobile daily-use friction: the official Android WireGuard client has no native trusted-Wi-Fi auto-connect feature, so users toggle the tunnel manually when switching between trusted and untrusted networks.

### Residual risks (accepted)

- **Hetzner single-box blast radius.** The server WireGuard private key, all peer public keys, the Cloudflare API token, the Let's Encrypt account key, the database credentials, the object storage credentials, and the session secrets are all co-located on one VPS. Root on the box means full compromise. This is the same blast radius as any single-VPS deployment and is not worsened by the WireGuard choice. Per-service secret separation, KMS, and multi-host isolation are post-pilot hardening tasks.
- **Cloudflare as CA-equivalent trust root.** A Cloudflare account compromise permits issuance of a valid Let's Encrypt certificate by writing `_acme-challenge` TXT records in the domain's public zone. `CAA` records pinning Let's Encrypt do not defend against this, because the attacker is using Let's Encrypt legitimately. This is the residual cost of DNS-01 via any public DNS provider and is accepted. Mitigation is limited to monitoring: CAA drift alerts, API token rotation, scoped token permissions (`Zone:DNS:Edit` + `Zone:Zone:Read` on the single managed zone, never the Global API Key).
- **Apple platforms unsupported.** Users on iOS or macOS cannot access the application through this VPN. Re-evaluated only if project scope later includes Apple platforms — the upstream `wireguard-apple` situation would also need to change.
- **Manual peer management until the admin web app ships.** Offboarding is manual; audit trail is the git history of `wg0.conf` until the admin web app introduces structured logging.

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [ADR-0005: Session management — HttpOnly cookies](0005-session-management-httponly-cookies.md) — `Secure` flag requires TLS in all deployments
- [ADR-0009: Pin Docker versions across environments](0009-pin-docker-versions-across-environments.md) — related dependency-pin tracking problem
- [docs/ops/server-setup.md](../ops/server-setup.md) — current server configuration and firewall rules
