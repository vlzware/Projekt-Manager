# ADR-0006: Password policy — NIST SP 800-63B with local blocklist

- **Status:** Accepted
- **Date:** 2026-04-05
- **Confidence:** High

## Context

The initial implementation enforced only `password.length >= 8`. No maximum length check (bcrypt silently truncates at 72 bytes), no complexity requirements, no check against known-compromised passwords.

Key forces:

- **NIST SP 800-63B (2024 revision)** explicitly recommends against traditional complexity rules (uppercase, digit, special character). Evidence shows these rules lead to predictable patterns (`P@ssw0rd!`) without improving effective entropy.
- **Breach-list checking** is the current industry standard. If a password has appeared in a known data breach, it is already in attacker dictionaries regardless of its complexity score.
- **Deployment context.** The system is a VPN-internal tool. The primary brute-force mitigation is rate limiting (5 attempts/minute) + bcrypt cost 10 (~100ms/attempt), not password complexity.

## Decision

Password policy follows NIST SP 800-63B:

1. **Minimum length: 8 characters** — counted in JavaScript `.length` (UTF-16 code units, close enough to "characters" for the user-facing rule)
2. **Maximum length: 72 UTF-8 bytes** — counted with `Buffer.byteLength(pw, 'utf8')`, matching bcrypt's internal truncation point so users are never silently given a weaker password than they intended. Counting characters instead would be a trap: `'测'.repeat(25)` is 25 characters but 75 bytes, and bcrypt would truncate to the first ~24 characters regardless
3. **Local blocklist: ~100 common passwords** — checked server-side before hashing; rejects trivially guessable passwords (`password`, `123456`, `changeme`, etc.) with a German-language error message
4. **No complexity rules** — no requirements for uppercase, digits, or special characters. This is a deliberate NIST-aligned choice, not an omission.

The blocklist is a bundled static list, not an external API call.

All three rules live in a single module (`src/server/config/password-policy.ts`) so the change-password endpoint and the first-run admin bootstrap (see ADR-0010) cannot drift. Rule ordering is cheap-to-expensive: length checks first, blocklist lookup last.

## Alternatives Considered

### Traditional complexity rules (uppercase + digit + special character)

The pre-NIST approach still used by many systems. Rejected because NIST evidence shows it produces predictable substitution patterns (`Password1!`, `Sommer2026!`) that are trivially cracked by rule-based attacks, while annoying users into writing passwords on sticky notes.

### Have I Been Pwned (HIBP) k-anonymity API

The gold standard for breach checking. Sends a 5-character SHA-1 prefix to the API, receives ~500 matching suffixes, checks locally. The full password never leaves the server.

Rejected for now because:

- Adds an external runtime dependency for a VPN-internal tool
- The VPN context already limits the attack surface significantly
- A local blocklist catches the worst offenders at zero operational cost

**Upgrade path:** If the application becomes publicly accessible, switching from the local blocklist to HIBP is a drop-in replacement in the change-password handler. The interface is the same (`isCommonPassword(pw): boolean`), only the implementation changes.

### No blocklist (rely on rate limiting + bcrypt alone)

Rate limiting at 5/min + bcrypt at ~100ms/attempt makes online brute force impractical. A blocklist is arguably redundant for this threat model.

Rejected because the blocklist costs near-zero (static set lookup, no I/O) and catches the embarrassing edge case where a user sets their password to `changeme` or `password`. Defense in depth at negligible cost.

## Consequences

### Positive

- Aligns with current NIST recommendations — the policy is defensible under audit
- No user frustration from arbitrary complexity rules
- Upgrade path to HIBP is straightforward if deployment context changes
- bcrypt max-length enforcement (in bytes) prevents the silent truncation trap for both ASCII and multi-byte UTF-8 passwords

### Negative

- The local blocklist is small (~100 entries) and static — it will not catch passwords that appear in new breaches. Acceptable for VPN-internal deployment.
- No check against the username or display name as a password — a minor gap that could be added later

## References

- [NIST SP 800-63B — Digital Identity Guidelines: Authentication](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [Have I Been Pwned — Passwords API](https://haveibeenpwned.com/API/v3#PwnedPasswords)
