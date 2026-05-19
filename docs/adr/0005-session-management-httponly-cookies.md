# ADR-0005: Session management — HttpOnly cookies with SameSite=Strict

- **Status:** Accepted
- **Date:** 2026-04-05
- **Confidence:** High

## Context

The initial implementation stored session tokens in `localStorage` and attached them as `Authorization: Bearer` headers. Vulnerable to XSS: any script in the page (compromised dependency, extension, injection) can read `localStorage.getItem('authToken')` and exfiltrate the session.

The application is a same-origin SPA — Fastify serves both API and static frontend from the same origin. No cross-origin API consumers.

Key forces:

- **XSS resilience.** `localStorage` is readable by any JavaScript; `HttpOnly` cookies are not.
- **CSRF prevention.** Cookies introduce CSRF risk (auto-attached cross-origin), which must be mitigated simultaneously.
- **Deployment context.** Internal tool accessed via VPN. The main downside of `SameSite=Strict` (external link → logged-in navigation) is irrelevant here.

## Decision

Session tokens live in an `HttpOnly; Secure; SameSite=Strict` cookie set by the server. The frontend never sees or manages the token.

- **Login:** Server sets `Set-Cookie: session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`. Response body has user info only.
- **Requests:** Frontend uses `credentials: 'same-origin'`; browser attaches the cookie automatically.
- **Logout:** Server clears the cookie and deletes the session row.
- **CSRF protection:** `SameSite=Strict` blocks the cookie on any cross-origin request (including form submissions and top-level navigations). Combined with CORS `origin: false` and CSP `default-src 'self'` — three independent CSRF barriers.

No additional CSRF token (synchronizer or double-submit) is used.

## Alternatives Considered

### HttpOnly cookie with SameSite=Lax + CSRF synchronizer token

`Lax` allows the cookie on top-level GET navigations from external sites, preserving the "click link from email → arrive logged in" UX, but requires an explicit CSRF token for state-changing requests. Rejected: the external-link benefit is irrelevant for a VPN-internal tool, and a CSRF token adds generation/storage/validation/wiring complexity without material security benefit over `Strict`.

### Keep localStorage with Bearer tokens

JSX escaping + `@fastify/helmet` CSP + no `dangerouslySetInnerHTML` + strict typing give a strong XSS posture; the remaining risk is a compromised npm dependency reading `localStorage`. Rejected: the cookie approach eliminates that risk class entirely at minimal cost — the token should not be JS-accessible if it doesn't need to be.

## Consequences

### Positive

- Session tokens invisible to client-side JavaScript — XSS cannot steal sessions
- CSRF blocked by three independent layers (SameSite=Strict, CORS, CSP)
- Simpler frontend — no token management, no `Authorization` header, no `localStorage` sync
- `Secure` flag (in production) keeps the cookie off plain HTTP

### Negative

- External-link arrivals (email, Slack) must log in again — `Strict` suppresses the cookie on cross-origin navigations. Acceptable for VPN-internal; reassess if public
- Integration tests must extract cookies via `set-cookie` header rather than reading a token from the response body — slightly more setup
- Future cross-origin API consumers (mobile app, third-party) would need an augmented auth path (e.g., separate token-based flow)

## Dep lifecycle health (as of 2026-05-18)

The cookie attributes (`HttpOnly`, `Secure`, `SameSite=Strict`) are stdlib-level browser primitives — no third-party dep is committed by the Decision itself. The "three independent CSRF barriers" rationale leans on three primitives, one of which (CSP) is implemented in the codebase via `@fastify/helmet`. That library is the only dep this ADR's argumentation touches.

| Dep               | Last release        | License | Maintainership                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------- | ------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fastify/helmet` | 13.0.2 (2025-09-28) | MIT     | Fastify team (18 maintainers on npm, including Matteo Collina), very active org | [deps.dev](https://deps.dev/npm/%40fastify%2Fhelmet) — applies the CSP `default-src 'self'` policy that backs the third CSRF barrier in the Decision. ~7.5 months since last release; healthy for a thin wrapper around `helmet` whose surface area is stable. Bumped lockstep with `fastify` via the Fastify family Renovate group ([dep-management.md](../ops/dep-management.md)) |

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [ADR-0004: Backend stack — Fastify, Drizzle ORM, node-postgres](0004-backend-stack-fastify-drizzle-node-postgres.md)
