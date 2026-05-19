# ADR-0016: LLM email extraction via server-proxied OpenRouter

- **Status:** Accepted
- **Date:** 2026-04-13
- **Confidence:** High

## Context

Per [ADR-0015](0015-copy-paste-textarea-email-data-intake.md), email text enters via a copy/paste textarea. An LLM extracts structured data (customer name, address, project details) and pre-fills the form.

This requires calling a third-party LLM API (OpenRouter) and managing the API key. Three forces constrain the architecture:

1. **CSP blocks browser-direct calls.** `connectSrc: ["'self'"]` (`src/server/app.ts`) prevents `fetch()` to any external origin. Relaxing widens the exfiltration surface.
2. **ADR-0005 keeps secrets out of JavaScript.** HttpOnly cookies exist specifically to prevent XSS from stealing tokens. A JS-readable API key contradicts this.
3. **The API key is per-installation.** Two users (owner, office manager) share one company OpenRouter account; per-user key management adds complexity without benefit.

The key is rate-limited and spend-capped on OpenRouter's dashboard, bounding compromise blast radius.

## Decision

Proxy OpenRouter calls through a server route (`POST /api/extract`). The API key lives as `OPENROUTER_API_KEY` in `secrets.env.age`, managed identically to existing deployment secrets (Postgres password, MinIO credentials, Cloudflare token). The key never reaches the browser.

The LLM model defaults to a hardcoded constant (`google/gemini-2.5-flash-lite`) with an optional `OPENROUTER_MODEL` env var override. Model selection is a technical/operational decision, not exposed in the UI.

## Alternatives Considered

### Browser-direct calls (key in browser)

Browser calls `https://openrouter.ai/api/v1/chat/completions` directly with the key in localStorage/sessionStorage. OpenRouter's CORS (`access-control-allow-origin: *`) permits it today. Ruled out: CSP blocks it; relaxing widens exfiltration surface; storing the key in JS contradicts ADR-0005; OpenRouter's CORS is undocumented and could change — brittle dependency on a third party's infra decision.

### Per-user key encrypted in DB with password-derived key

Each user stores their own key, encrypted with a symmetric key derived from their password (PBKDF2/HKDF), separate from the bcrypt hash. Decryption requires plaintext password — available only at login.

Ruled out: per-installation key makes per-user encryption pointless — both users store the same value. Adds significant complexity (key derivation, salt management, re-encryption on password change) for no security benefit here.

### Per-user key encrypted in DB with server-side env var secret

Same, but encrypted with AES using a server-side env var. Simpler than password-derived, but still needs encryption utilities, a DB schema change, a settings endpoint, and a rotation script.

Ruled out: with a per-installation key, the env var already holds the secret securely. Adding a DB layer is unnecessary indirection — the key would be encrypted with a secret stored in the same environment that already has direct access to it.

## Consequences

### Positive

- CSP and ADR-0005 untouched — no security posture changes
- Key management reuses the existing `secrets.env.age` + `age` pattern — no new infrastructure
- The proxy route follows established patterns (auth middleware, schema validation, service layer, centralized error handling) — low implementation risk
- OpenRouter's spend cap and rate limits provide defense-in-depth regardless of storage approach

### Negative

- Server becomes a proxy for every extraction — one more route to maintain and one outbound dependency (OpenRouter availability)
- Rotating the key means updating `secrets.env.age` and restarting — no UI path
- Customer email text transits through the server en route to OpenRouter — already handled, but an additional processing path to audit

## Dep lifecycle health (as of 2026-05-15)

| Dep                                  | Status                                                        | Notes                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenRouter (SaaS)                    | Active commercial provider, founded 2023, well-funded         | Multi-model gateway with OpenAI-API-compatible surface. Exit ramp is structural: the proxy route is provider-agnostic, so switching to any OpenAI-compatible provider (or direct provider integrations — Anthropic, Google AI, OpenAI) is an env-var change. |
| Model `google/gemini-2.5-flash-lite` | Google-managed, subject to Google's model retirement schedule | Pinned as hardcoded constant with `OPENROUTER_MODEL` env override; rollover when the model retires is a no-code change. OpenRouter's model catalog is the authoritative "alive" check.                                                                       |

## References

- [ADR-0005](0005-session-management-httponly-cookies.md) — Session management, HttpOnly cookies
- [ADR-0008](0008-vpn-first-network-access.md) — VPN-first network access
- [ADR-0015](0015-copy-paste-textarea-email-data-intake.md) — Copy/paste textarea for email data intake
- [Issue #87](https://github.com/vlzware/Projekt-Manager/issues/87) — Decision: LLM extraction of data from emails
- [OpenRouter API quickstart](https://openrouter.ai/docs/quickstart.md)
