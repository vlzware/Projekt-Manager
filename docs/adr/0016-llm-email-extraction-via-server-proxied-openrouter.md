# ADR-0016: LLM email extraction via server-proxied OpenRouter

- **Status:** Accepted
- **Date:** 2026-04-13
- **Confidence:** High

## Context

Per [ADR-0015](0015-copy-paste-textarea-email-data-intake.md), email text enters the application via a copy/paste textarea. An LLM extracts structured data (customer name, address, project details) from the raw text and pre-fills the relevant form.

This requires calling a third-party LLM API (OpenRouter) and managing the associated API key. Three forces constrain the architecture:

1. **CSP blocks browser-direct calls.** `connectSrc: ["'self'"]` (`src/server/app.ts`) prevents the browser from making `fetch()` calls to any external origin. Relaxing this widens the data-exfiltration surface.
2. **ADR-0005 keeps secrets out of JavaScript.** The session security model uses HttpOnly cookies specifically to prevent XSS from stealing tokens. Exposing an API key as a JavaScript-readable value contradicts this principle.
3. **The API key is a per-installation concern.** Two users (owner, office manager) share one company OpenRouter account. Per-user key management adds complexity without benefit.

The API key is rate-limited and spend-capped on OpenRouter's dashboard, which bounds the blast radius of a compromise.

## Decision

We will proxy OpenRouter calls through a server route (`POST /api/extract`). The API key is stored as an environment variable (`OPENROUTER_API_KEY`) in `secrets.env.age`, managed identically to existing deployment secrets (Postgres password, MinIO credentials, Cloudflare token). The key never reaches the browser.

The LLM model defaults to a hardcoded constant (`google/gemini-2.5-flash-lite`) with an optional `OPENROUTER_MODEL` env var override. Model selection is a technical/operational decision, not exposed in the UI.

## Alternatives Considered

### Browser-direct calls to OpenRouter (key in browser)

The browser calls `https://openrouter.ai/api/v1/chat/completions` directly, with the API key stored in localStorage or sessionStorage. OpenRouter's CORS policy (`access-control-allow-origin: *`) permits this today. Main advantage: no backend route needed.

Ruled out: CSP `connectSrc: ["'self'"]` blocks the call. Relaxing CSP widens the exfiltration surface. Storing the key in JavaScript contradicts ADR-0005. OpenRouter's CORS policy is undocumented and could change, creating a brittle dependency on a third party's infrastructure decision.

### Per-user key encrypted in DB with password-derived key

Each user stores their own OpenRouter key. The key is encrypted with a symmetric key derived from the user's password (PBKDF2/HKDF), separate from the bcrypt hash used for authentication. Decryption requires the plaintext password, available only at login time.

Ruled out: per-installation key makes per-user encryption pointless — both users would store the same value. The approach also adds significant complexity (key derivation, salt management, re-encryption on password change) for no security benefit in this context.

### Per-user key encrypted in DB with server-side env var secret

Same as above, but encrypted with AES using a server-side env var instead of a password-derived key. Simpler than the password-derived variant, but still requires encryption utilities, a DB schema change, a settings endpoint, and a key rotation script.

Ruled out: with a per-installation key, the env var already holds the secret securely. Adding a DB layer on top is unnecessary indirection — the key would be encrypted with a secret stored in the same environment that already has direct access to it.

## Consequences

### Positive

- CSP and ADR-0005 remain untouched — no security posture changes
- Key management follows the existing deployment secret pattern (`secrets.env.age` + `age`) — no new infrastructure
- The proxy route follows established codebase patterns (auth middleware, schema validation, service layer, centralized error handling) — low implementation risk
- OpenRouter's spend cap and rate limits provide defense-in-depth regardless of storage approach

### Negative

- The server becomes a proxy for every extraction request — adds one route to maintain and one outbound dependency (OpenRouter availability)
- Changing the API key requires updating `secrets.env.age` and restarting the service — no UI path
- Customer email text transits through the server en route to OpenRouter — the server already handles this data, but it's an additional processing path to audit

## References

- [ADR-0005](0005-session-management-httponly-cookies.md) — Session management, HttpOnly cookies
- [ADR-0008](0008-vpn-first-network-access.md) — VPN-first network access
- [ADR-0015](0015-copy-paste-textarea-email-data-intake.md) — Copy/paste textarea for email data intake
- [Issue #87](https://github.com/vlzware/Projekt-Manager/issues/87) — Decision: LLM extraction of data from emails
- [OpenRouter API quickstart](https://openrouter.ai/docs/quickstart.md)
