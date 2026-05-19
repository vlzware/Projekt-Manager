# ADR-0013: HTTP-only evaluation mode for full-stack integration testing

- **Status:** Accepted
- **Date:** 2026-04-10
- **Confidence:** High

## Context

Issue #47 established "no HTTP — nowhere, no exceptions" after a deployment audit found zero TLS. Production now enforces HTTPS end-to-end: Caddy terminates TLS with a Let's Encrypt cert via DNS-01 ACME, behind WireGuard (ADR-0008). That posture is correct and unchanged.

The gap is between local dev and production. Two run modes:

1. **Local dev** (`npm run dev`) — Node + Vite directly, no Docker, no Caddy. Fast, but exercises none of the production infrastructure.
2. **Production** — Docker image, Caddy, Postgres, MinIO, TLS, WireGuard, domain, Cloudflare DNS tokens. Full stack.

Nothing in between. Testing Docker image builds, Caddyfile proxy behaviour, compose wiring, or security headers requires a domain, DNS credentials, TLS certs, and a VPN. Consequences:

- Integration bugs surface only at the final deployment stage — the most expensive place to find them.
- E2E tests against the real Docker stack need the full TLS infrastructure.
- Ops documentation cannot be verified by a contributor without VPN access and a domain.
- Deployment workflow docs cannot be declared correct without this scenario.

The HTTPS-everywhere principle was never wrong. Enforcing it _unconditionally_ for ephemeral evaluation creates friction that pushes integration testing to the end of the pipeline.

## Decision

Add an opt-in HTTP-only evaluation mode that runs the full production stack (app image, Caddy, Postgres, MinIO) over plain HTTP without a domain, TLS, or VPN. Off by default, explicit activation, blocked from production.

### Mechanism

- **`ALLOW_INSECURE_HTTP`** env var (default `false`). When `true`:
  - Disables `Secure` flag on session cookies (so login works over HTTP).
  - Disables HSTS (meaningless over HTTP; creates browser state conflicts).
  - Removes `upgrade-insecure-requests` from CSP (otherwise browsers rewrite HTTP subresources to HTTPS, breaking all asset loads).
  - Logs a startup warning.

- **`docker-compose.http.yml`** — compose override. Replaces the custom Caddy build (Cloudflare DNS plugin) with stock Caddy on port 80, sets `NODE_ENV=development` (enabling seed data and dev credentials), sets `ALLOW_INSECURE_HTTP=true`. Activated by explicit `-f`:

  ```
  docker compose -f docker-compose.yml -f docker-compose.http.yml up -d
  ```

- **`Caddyfile.http`** — minimal reverse proxy on `:80`, no TLS.

### Guards against misuse

- **Hard production refusal.** Server throws and refuses to start if `ALLOW_INSECURE_HTTP=true` and `NODE_ENV=production`. Fail-closed.
- **UI banner.** Red banner on every page: "UNSICHERER MODUS — Keine Verschlüsselung, Zugangsdaten werden im Klartext übertragen". On login and authenticated views. Impossible to miss or dismiss.
- **Title prefix.** Browser tab reads "UNSICHER – Projekt-Manager". Visible when the tab is unfocused.
- **Client-side detection.** Banner driven by `window.location.protocol`, not the env var — fires on any non-localhost HTTP regardless of server config.
- **Documentation.** `docs/ops/http-only-evaluation.md` opens with a warning and includes a graduating-to-production checklist.

## Alternatives considered

- **Status quo — require full TLS for any Docker-based testing.** Absolute enforcement, zero exceptions. Pushes integration testing to end-of-pipeline, makes ops docs unverifiable without production-equivalent infra, and blocks non-VPN contributors from running the full stack. The principle is correct for production; making it a precondition for _evaluation_ turns a security control into a testing bottleneck.
- **Self-signed certs (Caddy `tls internal`).** Keeps TLS in the loop so cookie `Secure` and HSTS still work. Rejected: browser cert warnings are unprofessional in demos, actively train users to bypass warnings (opposite of ADR-0008 posture), and every test client needs explicit trust config. Small friction win over Let's Encrypt.
- **Rely on `NODE_ENV=development` alone.** Cookie logic already ties `cookieSecure` to `NODE_ENV=production`, so `NODE_ENV=development` disables `Secure`. Rejected: `NODE_ENV` is a blunt instrument — it controls seeding, debug logging, dev credentials, and more. A dedicated flag isolates the HTTP-specific relaxations (HSTS, CSP `upgrade-insecure-requests`) from the dev-mode feature bundle and makes intent explicit.

## Consequences

### Positive

- Full production stack testable locally or on any VPS with `docker compose`. No domain, DNS, TLS, or VPN.
- Integration bugs in Dockerfile, Caddyfile, and compose wiring surface during routine development.
- Ops docs and deployment workflows verifiable end-to-end by anyone with Docker.
- E2E tests can target the Docker stack.
- Production security posture completely unchanged. ADR-0008, ADR-0005, and #47 all hold for production.

### Negative

- Additional code path to maintain: client-side detection, banner component, `Caddyfile.http`, compose override, env-var plumbing, production guard.
- If someone ignores the banner and uses real data in HTTP mode, credentials travel in cleartext. Guards make this hard to do accidentally but do not prevent it.
- HSTS state conflict: a browser that previously visited the HTTPS version may refuse HTTP for up to 180 days. Workaround documented in `http-only-evaluation.md` (different browser or clear HSTS state).

## References

- [#47 — Enforce HTTPS everywhere](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/47) — established the HTTPS-everywhere principle; this ADR introduces a guarded exception for evaluation
- [ADR-0008: VPN-first network access](0008-vpn-first-network-access.md) — production TLS and VPN posture, unchanged
- [ADR-0005: Session management — HttpOnly cookies](0005-session-management-httponly-cookies.md) — `Secure` flag behavior relaxed only under `ALLOW_INSECURE_HTTP`
- [docs/ops/http-only-evaluation.md](../ops/http-only-evaluation.md) — operational guide for the HTTP-only mode
