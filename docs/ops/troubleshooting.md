# Operations — Troubleshooting

Knowledge learned the hard way. Each entry names the trap, the root cause, and the workaround — in that order. Add new entries as they are discovered; keep them terse.

## Caddy `{$VAR:default}` does not default empty strings

**Trap:** `{$ACME_CA_URL:https://acme-v02.api.letsencrypt.org/directory}` in a Caddyfile does **not** fall back to the default when `ACME_CA_URL=""`. Only _unset_ triggers the default — an empty value is substituted verbatim, which Caddy then treats as an invalid ACME endpoint.

**Root cause:** Caddy's env-var substitution distinguishes unset from empty; the `:default` syntax only fires on unset.

**Workaround:** Hardcode the production value in the Caddyfile. For staging bootstrap, edit the file manually (see [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md)) and revert after the cert is issued. Do not rely on "toggle via env var" for cert authority selection.

## Docker Compose runtime commands are not interchangeable

**Trap:** Picking the wrong one silently ignores a config change. No error is raised.

**The three commands and what each one actually does:**

- `docker compose restart <svc>` — **does not** re-read `.env` or the compose file. Env-var changes are ignored. Never use after editing `.env`.
- `docker compose up -d <svc>` — re-reads `.env` and the compose file, detects diffs, and recreates any service whose config changed. **Does not** notice bind-mount content changes.
- `docker compose up -d --force-recreate <svc>` — always recreates. Use this when you edited a bind-mounted file (Caddyfile, Corefile, etc.) and need the container to see the new content.

**Rule of thumb:** After editing `.env` → `up -d`. After editing a bind-mounted file → `up -d --force-recreate`. `restart` alone is almost never what you want.

## \[skip ci\] matches anywhere in the commit body, including quoted text

**Trap:** GitHub Actions scans the raw commit message for five bracketed skip directives: \[skip ci\], \[ci skip\], \[no ci\], \[skip actions\], \[actions skip\]. The match is a plain substring check — backticks, quotes, code fences, and markdown escapes in the rendered view do **not** shield the raw text. Naming one verbatim anywhere in a commit body (even in quoted docs prose) skips CI for that commit. Follow-up commits riding on the same push are skipped too, because GitHub only evaluates the push's head commit.

**Root cause:** The skip check runs against raw commit message bytes before any rendering or parsing. Whatever the author typed is what the scanner sees.

**Workaround:** When you need to name a skip directive in a commit message or docs prose, break the substring so the raw bytes are not contiguous:

- Backslash-escape each bracket in markdown: `\[skip ci\]` renders as the bracketed form but the raw bytes include backslashes.
- Split the characters: `"skip" "ci"`, or write the tokens on separate lines.
- Use a noun form instead: "skip-ci directive".
- Link to GitHub's docs instead of inlining the literal form.

For docs prose, backslash escape reads cleanest. For commit messages (which GitHub's scanner does not render), the noun form is the only safe option. The first push of this doc file itself tripped the trap — a reminder that the scanner does not care whether the author meant it.

## `curl --resolve` is a slice test, not an end-to-end test

**Trap:** `curl --resolve host:port:ip` (or `/etc/hosts` override) bypasses DNS entirely. A successful response proves TCP/TLS/app work, but says nothing about whether the real DNS path resolves correctly. It is easy to conclude "it works" when the actual statement is "it works _if DNS is also correct_".

**Workaround:** Whenever you use `--resolve` or an `/etc/hosts` override in testing, mark the test explicitly as a bypass and re-test without the override before calling anything done. A browser hitting the bare hostname is the minimum bar for "end-to-end verified".

## Caddy cert storage is per-CA

**Trap:** Switching ACME CAs (staging ↔ production) looks like "Caddy lost my certificate" because Caddy stores issued certs under a per-CA directory: `acme-staging-v02.../prmng.org/` vs `acme-v02.../prmng.org/`. Switching CAs reads the new directory; if empty, Caddy obtains a fresh cert from that CA.

**Useful consequence:** staging and production certs coexist without conflicting. You can flip between them repeatedly during bootstrap.

**Force re-issuance:** delete the per-CA subdirectory for the domain. Caddy will re-request on next restart.

## `env | grep TOKEN` leaks the token into the conversation

**Trap:** Diagnosing env issues with `env | grep <NAME>` dumps the full value wherever the command output is displayed. If the shell is an agent transcript or a shared session, the secret is now in the log.

**Workaround:** Habit — filter values by default. Use `env | grep -E '^(TOKEN\|KEY\|PASSWORD\|SECRET)=' | sed -E 's/=.*/=<redacted>/'` or similar. If a value has already been exposed, rotate it immediately; do not rely on "I can scroll up and delete the line".
