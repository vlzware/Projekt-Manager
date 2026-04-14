# ADR-0015: Copy/paste textarea for email data intake

- **Status:** Accepted
- **Date:** 2026-04-13
- **Confidence:** High

## Context

The kickoff defined a requirement: "Customer data, arriving in emails, can be extracted using LLMs and fed into the main system in a user-friendly, trivial way." Emails arrive in a standard email client (Thunderbird). The application needs a mechanism to get the raw email text into the system for LLM extraction.

Three integration points were considered, each with a different friction/complexity tradeoff.

## Decision

We will use a copy/paste textarea within the application. The user copies the email text from their email client, pastes it into a textarea, and triggers extraction. This is one trivial step more than a one-click solution, with dramatically lower implementation and maintenance cost.

## Alternatives Considered

### Thunderbird extension

A browser-extension-style add-on for Thunderbird that sends email content to the application with one click. Most user-friendly option. Ruled out: requires maintaining a separate project with its own release cycle, and the secure sync mechanism between extension and application is an unsolved design problem.

### Embedded basic email client

The application connects directly to the mailbox (IMAP/OAuth) and renders emails in-app. The user never leaves the application. Ruled out: significant complexity (IMAP integration, OAuth flows, mail rendering, attachment handling) and external dependencies disproportionate to the problem being solved.

## Consequences

### Positive

- No external dependencies or additional projects to maintain
- No special security considerations beyond what the application already handles
- Implementation is a standard UI component — no novel engineering

### Negative

- One additional manual step (copy/paste) compared to a one-click extension
- Formatting artifacts from the email client's clipboard may affect extraction quality — the LLM prompt must be tolerant of these

## References

- [Issue #87](https://github.com/vlzware/Projekt-Manager/issues/87) — Decision: LLM extraction of data from emails
