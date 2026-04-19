# ADR-0006: Password policy — NIST SP 800-63B with local blocklist

- **Status:** Accepted
- **Date:** 2026-04-05
- **Confidence:** High

## Context

The initial implementation enforced only `password.length >= 8`. No max-length check (bcrypt silently truncates at 72 bytes), no complexity rules, no breach-list check.

Key forces:

- **NIST SP 800-63B (2024 revision)** recommends against traditional complexity rules (uppercase, digit, special). Evidence: these rules produce predictable patterns (`P@ssw0rd!`) without adding effective entropy.
- **Breach-list checking** is the current standard — a password in a known breach is already in attacker dictionaries regardless of its complexity score.
- **Deployment context.** VPN-internal tool. Primary brute-force mitigation is rate limiting (5/min) + bcrypt cost 10 (~100ms/attempt), not password complexity.

## Decision

Password policy follows NIST SP 800-63B:

1. **Min length: 8 characters** — `.length` in JavaScript (UTF-16 code units, close enough for the user-facing rule).
2. **Max length: 72 UTF-8 bytes** — `Buffer.byteLength(pw, 'utf8')`, matching bcrypt's internal truncation so users aren't silently given a weaker password than intended. Counting characters would be a trap: `'测'.repeat(25)` is 25 characters but 75 bytes, and bcrypt would truncate anyway.
3. **Local blocklist: ~100 common passwords** — checked server-side before hashing; rejects `password`, `123456`, `changeme`, etc. with a German-language error.
4. **No complexity rules** — deliberate, NIST-aligned.

The blocklist is a bundled static list, not an external API call.

All rules live in a single module (`src/server/config/password-policy.ts`) so change-password and first-run admin bootstrap ([ADR-0010](0010-first-run-admin-bootstrap.md)) cannot drift. Rule ordering is cheap-to-expensive: length checks first, blocklist last.

## Alternatives Considered

### Traditional complexity rules (uppercase + digit + special)

Pre-NIST approach still in widespread use. Rejected: NIST evidence shows it produces predictable substitutions (`Password1!`, `Sommer2026!`) trivially cracked by rule-based attacks, while pushing users to sticky notes.

### Have I Been Pwned (HIBP) k-anonymity API

Gold standard — sends a 5-character SHA-1 prefix, receives ~500 matching suffixes, checks locally. Full password never leaves the server. Rejected for now: external runtime dependency for a VPN-internal tool, and a local blocklist catches the worst offenders at zero operational cost.

**Upgrade path:** If the app goes public, swapping the local blocklist for HIBP is a drop-in replacement — same `isCommonPassword(pw): boolean` interface.

### No blocklist (rate limiting + bcrypt alone)

5/min rate limit + bcrypt at ~100ms/attempt makes online brute force impractical, arguably making the blocklist redundant. Rejected: the blocklist is near-zero cost (static set lookup) and catches the embarrassing `changeme` / `password` case. Defense in depth.

## Consequences

### Positive

- Aligns with current NIST recommendations — defensible under audit
- No user frustration from arbitrary complexity rules
- Drop-in upgrade path to HIBP if deployment context changes
- Byte-based max-length prevents silent bcrypt truncation for both ASCII and multi-byte UTF-8

### Negative

- Blocklist is small (~100 entries) and static — misses passwords from new breaches. Acceptable for VPN-internal
- No check against username or display name as a password — minor gap, addable later

## References

- [NIST SP 800-63B — Digital Identity Guidelines: Authentication](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [Have I Been Pwned — Passwords API](https://haveibeenpwned.com/API/v3#PwnedPasswords)
