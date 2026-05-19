# ADR-0015: Copy/paste textarea for email data intake

- **Status:** Accepted
- **Date:** 2026-04-13
- **Confidence:** High

## Context

The kickoff requires: "Customer data, arriving in emails, can be extracted using LLMs and fed into the main system in a user-friendly, trivial way." Emails arrive in a standard client (Thunderbird). The app needs a mechanism to get raw email text in for LLM extraction.

## Decision

Use a copy/paste textarea in the application. The user copies email text from their client, pastes it, and triggers extraction. One trivial step more than one-click, at dramatically lower implementation and maintenance cost.

## Alternatives Considered

### Thunderbird extension

An add-on that sends email content to the app with one click. Most user-friendly. Ruled out: a separate project with its own release cycle, and the secure sync between extension and app is an unsolved design problem.

### Embedded basic email client

The app connects directly to the mailbox (IMAP/OAuth) and renders emails in-app. Ruled out: significant complexity (IMAP, OAuth, rendering, attachments) disproportionate to the problem.

## Consequences

### Positive

- No external dependencies or additional projects to maintain
- No special security considerations beyond what the app already handles
- Standard UI component — no novel engineering

### Negative

- One extra manual step vs. a one-click extension
- Clipboard formatting artifacts may affect extraction — the LLM prompt must tolerate them

## References

- [Issue #87](https://github.com/Projekt-Manager-Org/Projekt-Manager/issues/87) — Decision: LLM extraction of data from emails
