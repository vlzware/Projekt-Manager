# ADR-0013: HTTP-only evaluation mode for full-stack integration testing

- **Status:** Accepted
- **Date:** 2026-04-10
- **Confidence:** High

## Context

Issue #47 established the principle "no HTTP — nowhere, no exceptions" after a deployment audit found zero TLS in the stack. The production environment now enforces HTTPS end-to-end: Caddy terminates TLS with a real Let's Encrypt certificate via DNS-01 ACME, behind a WireGuard VPN (ADR-0008). That posture is correct and unchanged by this decision.

The problem is the gap between local development and production. The project has two run modes:

1. **Local dev** (`npm run dev`) — Node + Vite directly, no Docker, no Caddy. Fast iteration, but exercises none of the production infrastructure.
2. **Production** — Docker image, Caddy reverse proxy, Postgres, MinIO, TLS, WireGuard, a domain, Cloudflare DNS tokens. The full stack.

There is nothing in between. To test whether the Docker image builds correctly, the Caddyfile proxies traffic properly, the compose file wires services together, or the security headers behave as expected — you need a domain, DNS provider credentials, TLS certificates, and a VPN. This means:

- Integration bugs in the Docker image, Caddyfile, or compose wiring surface only at the final deployment stage — the most expensive place to discover them.
- E2E tests against the real Docker stack cannot run without the full TLS infrastructure.
- Ops documentation ("how to run the stack") cannot be verified by a contributor without VPN access and a domain.
- The deployment workflow documentation cannot be proclaimed correct without accounting for this scenario.

The HTTPS-everywhere principle was never wrong. But enforcing it _unconditionally_ — including for ephemeral evaluation runs against throwaway data — creates friction that pushes integration testing to the end of the pipeline instead of making it routine.

## Decision

We will add an opt-in HTTP-only evaluation mode that runs the full production stack (app Docker image, Caddy, Postgres, MinIO) over plain HTTP without requiring a domain, TLS certificates, or VPN. The mode is off by default, requires explicit activation, and is blocked from production use.

### Mechanism

- **`ALLOW_INSECURE_HTTP`** environment variable (default: `false`). When `true`:
  - Disables the `Secure` flag on session cookies (so login works over HTTP)
  - Disables HSTS (meaningless over HTTP; creates browser state conflicts)
  - Removes `upgrade-insecure-requests` from CSP (otherwise browsers silently rewrite HTTP subresource URLs to HTTPS, breaking all asset loads)
  - Logs a startup warning to the console

- **`docker-compose.http.yml`** — a compose override that replaces the custom Caddy build (Cloudflare DNS plugin) with stock Caddy on port 80, sets `NODE_ENV=development` (enabling seed data and dev credentials), and sets `ALLOW_INSECURE_HTTP=true`. Activated by an explicit `-f` flag:

  ```
  docker compose -f docker-compose.yml -f docker-compose.http.yml up -d
  ```

- **`Caddyfile.http`** — minimal reverse proxy on `:80`, no TLS configuration.

### Guards against misuse

- **Hard production refusal.** The server throws and refuses to start if `ALLOW_INSECURE_HTTP=true` and `NODE_ENV=production`. Fail-closed.
- **UI banner.** A red banner at the top of every page reads "UNSICHERER MODUS — Keine Verschlüsselung, Zugangsdaten werden im Klartext übertragen". Present on both the login screen and the authenticated views. Impossible to miss, impossible to dismiss.
- **Title prefix.** The browser tab/title reads "UNSICHER – Projekt-Manager". Visible even when the tab is not focused.
- **Client-side detection.** The banner is driven by `window.location.protocol`, not by the env var — it fires on any non-localhost HTTP connection regardless of server configuration.
- **Documentation.** `docs/ops/http-only-evaluation.md` opens with a warning block and includes a "graduating to production" checklist.

## Alternatives considered

### Status quo — require full TLS infrastructure for any Docker-based testing

Main advantage: absolute enforcement of the HTTPS principle with zero exceptions. Ruled out because it pushes integration testing to the end of the deployment pipeline, makes ops documentation unverifiable without production-equivalent infrastructure, and blocks contributors without VPN access from running the full stack at all. The principle is correct for production; making it a precondition for _evaluation_ turns a security control into a testing bottleneck.

### Self-signed certificates (Caddy `tls internal`)

Caddy can generate self-signed certs without a domain or DNS provider. Main advantage: keeps TLS in the loop, so cookie `Secure` flag and HSTS still work. Ruled out because: browser certificate warnings are unprofessional in any demo context, they actively train users to bypass certificate warnings (the opposite of a security-conscious posture, per ADR-0008), and every test client requires explicit trust configuration. The friction reduction over full Let's Encrypt is small.

### Relying on `NODE_ENV=development` alone

The existing cookie logic already tied `cookieSecure` to `NODE_ENV=production`, so setting `NODE_ENV=development` already disables the `Secure` flag. Main advantage: no new env var. Ruled out because `NODE_ENV` is a blunt instrument — it controls seeding, debug logging, dev credentials, and other unrelated behaviors. A dedicated flag isolates the HTTP-specific relaxations (HSTS, CSP `upgrade-insecure-requests`) from the development-mode feature bundle and makes the intent explicit in configuration and code.

## Consequences

### Positive

- The full production stack (Docker image, Caddy reverse proxy, Postgres, MinIO) can be tested locally or on any VPS with `docker compose` and nothing else. No domain, no DNS, no TLS, no VPN required.
- Integration bugs in the Dockerfile, Caddyfile, and compose wiring surface during routine development, not at the final deployment stage.
- Ops documentation and deployment workflows can be verified end-to-end by anyone with Docker.
- E2E tests can target the Docker stack.
- Production security posture is completely unchanged. ADR-0008, ADR-0005, and the #47 principle all hold for production.

### Negative

- An additional code path to maintain: client-side insecure-connection detection, the banner component, `Caddyfile.http`, the compose override, the env var plumbing, and the production guard.
- If someone ignores the banner and uses real data in HTTP mode, credentials travel in cleartext. The guards make this hard to do accidentally but do not prevent it.
- HSTS state conflict: a browser that previously visited the HTTPS version may refuse HTTP for up to 180 days. Documented in `http-only-evaluation.md` with the workaround (different browser or clear HSTS state).

## References

- [#47 — Enforce HTTPS everywhere](https://github.com/vlzware/Projekt-Manager/issues/47) — established the HTTPS-everywhere principle; this ADR introduces a guarded exception for evaluation
- [ADR-0008: VPN-first network access](0008-vpn-first-network-access.md) — production TLS and VPN posture, unchanged
- [ADR-0005: Session management — HttpOnly cookies](0005-session-management-httponly-cookies.md) — `Secure` flag behavior relaxed only under `ALLOW_INSECURE_HTTP`
- [docs/ops/http-only-evaluation.md](../ops/http-only-evaluation.md) — operational guide for the HTTP-only mode
