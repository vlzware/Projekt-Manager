# ADR-0005: Session management — HttpOnly cookies with SameSite=Strict

- **Status:** Accepted
- **Date:** 2026-04-05
- **Confidence:** High

## Context

The initial implementation stored session tokens in `localStorage` and attached them as `Authorization: Bearer` headers on every fetch. This works but is vulnerable to XSS: any script running in the page (compromised dependency, browser extension, injected code) can read `localStorage.getItem('authToken')` and exfiltrate the session.

The application is a same-origin SPA — Fastify serves both the API and the static frontend from the same origin. There are no cross-origin API consumers.

Key forces:

- **XSS resilience.** `localStorage` is readable by any JavaScript in the page. `HttpOnly` cookies are invisible to JavaScript — the browser manages them automatically.
- **CSRF prevention.** Moving to cookies introduces CSRF risk, since browsers auto-attach cookies to cross-origin requests. This must be mitigated simultaneously.
- **Deployment context.** The system is an internal tool for Handwerker companies, accessed via VPN. External link → app navigation (the main downside of `SameSite=Strict`) is not a relevant use case.

## Decision

Session tokens are stored in an `HttpOnly; Secure; SameSite=Strict` cookie set by the server. The frontend never sees or manages the token.

- **Login:** Server sets `Set-Cookie: session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`. Response body contains user info only, no token.
- **All requests:** Frontend uses `credentials: 'same-origin'` on fetch calls. The browser attaches the cookie automatically.
- **Logout:** Server clears the cookie and deletes the session from the database.
- **CSRF protection:** `SameSite=Strict` prevents the browser from sending the cookie on any cross-origin request — including form submissions and top-level navigations. Combined with CORS `origin: false` and CSP `default-src 'self'`, this provides three independent CSRF barriers.

No additional CSRF token (synchronizer pattern, double-submit cookie) is used.

## Alternatives Considered

### HttpOnly cookie with SameSite=Lax + CSRF synchronizer token

`Lax` allows the cookie on top-level GET navigations from external sites, preserving the "click link from email → arrive logged in" experience. Requires an explicit CSRF token for state-changing requests.

Ruled out because:

- The external-link benefit is irrelevant for a VPN-internal tool
- The CSRF token adds complexity (token generation, storage, validation, frontend wiring) without proportional security benefit over `Strict`

### Keep localStorage with Bearer tokens

React's JSX escaping + `@fastify/helmet` CSP + no `dangerouslySetInnerHTML` + strict typing provide a strong XSS posture. The remaining risk vector is a compromised npm dependency reading `localStorage`.

Ruled out because the cookie approach eliminates this risk class entirely with minimal implementation cost. Defense in depth: the token should not be accessible to JavaScript if it doesn't need to be.

## Consequences

### Positive

- Session tokens are invisible to client-side JavaScript — XSS cannot steal sessions
- CSRF is blocked by three independent layers (SameSite=Strict, CORS, CSP)
- Frontend code is simpler — no token management, no `Authorization` header construction, no `localStorage` synchronization
- The `Secure` flag (in production) ensures the cookie is never sent over plain HTTP

### Negative

- Users arriving via external links (email, Slack) must log in again — `Strict` suppresses the cookie on cross-origin navigations. Acceptable for the VPN-internal context; would need reassessment if the app becomes publicly accessible.
- Integration tests must pass cookies via `set-cookie` header extraction rather than reading the token from the response body — slightly more involved test setup
- If the app ever needs cross-origin API consumers (mobile app, third-party integration), the cookie approach will need augmentation (e.g., a separate token-based auth path for API clients)

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [ADR-0004: Backend stack — Fastify, Drizzle ORM, node-postgres](0004-backend-stack-fastify-drizzle-node-postgres.md)
