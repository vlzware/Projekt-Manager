# ADR-0010: First-run admin bootstrap from environment variables

- **Status:** Accepted
- **Date:** 2026-04-08
- **Confidence:** High

## Context

The iteration-4 walking skeleton deploy exposed a gap between the specification and the production startup path. Spec §4.5 states "Default admin account — created during seed data loading", but `src/server/start.ts` correctly refuses to run `seed()` when `NODE_ENV=production` (seed plants 19 demo projects, five fake users with real German names, and an inactive user — none of which belong in real company data). Result: the production database is schema-migrated but empty, and every login attempt returns `INVALID_CREDENTIALS` with nothing behind it to authenticate against.

The gap surfaced during [#47](https://github.com/vlzware/Projekt-Manager/issues/47) (HTTPS enforcement) as "login broke after enforcing HTTPS." It had nothing to do with HTTPS — the HTTPS path is healthy, verified end-to-end with a temporary user. The real gap was that there has never been a real user, because no production bootstrap mechanism exists.

Constraints shaping the fix:

- Must not weaken the `NODE_ENV=production → skip seed()` guard.
- Must not require a manual ritual that re-creates the bug on every fresh deploy or `pgdata` volume rebuild.
- Must fail closed on half-configuration (an operator who sets a username but forgets the password should hit a loud error, not a silent empty database).
- Must be idempotent under restart — if the bootstrap ran, restarting the container with the same env vars must be a safe no-op.
- Credentials handling should minimise the window where plaintext sits on disk.

## Decision

We will add an **opt-in, environment-variable-driven first-run admin bootstrap** to the startup sequence in `src/server/start.ts`.

When the `users` table has zero rows AND both `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` are set, startup inserts a single `owner`-role user with the configured username, a bcrypt hash of the configured password, and `display_name = BOOTSTRAP_ADMIN_DISPLAY_NAME ?? username`. The insert happens after `migrate()` and before `app.listen()`. If the `users` table has one or more rows, the bootstrap hook is a no-op regardless of env var presence. If exactly one of the two required vars is set, startup refuses to continue and exits non-zero with a message naming the missing var. The bootstrap password must pass the standard password policy (minimum length, common-password blocklist) — startup fails with a policy violation message if it does not. A single `warn`-level log line on successful insert tells the operator to log in, change the password immediately, and remove the `BOOTSTRAP_ADMIN_*` vars from `.env` before the next deploy. The password is never logged at any level.

## Alternatives Considered

### Alternative A — Manual `psql` insert after each deploy

Operator SSHes to the box, runs `docker exec ... psql`, and inserts a row by hand with a pre-hashed password. Rejected: every fresh deploy and every `pgdata` volume rebuild reproduces the problem. Requires the operator to run a Node REPL or external bcrypt tool just to hash the password. Produces zero audit trail and invites copy-paste errors in production.

### Alternative B — Reuse `seed()` in production

Drop the `isProduction` guard in `start.ts` and let `seed()` run everywhere. Rejected: seed is a dev convenience fixture. Running it in production contaminates real data with 19 demo projects belonging to "Familie Müller" and "Café Sonnenschein" and creates users named after fake employees. The guard exists for good reasons — tearing it down to fix an adjacent problem is a downgrade, not a fix.

### Alternative C — Interactive CLI script (`npm run create-admin`)

Operator SSHes after each fresh deploy and runs a script that prompts for username and password on a TTY. Rejected for this iteration: adds a manual step on top of an otherwise-automated CD pipeline, and the credentials typed over SSH land in bash history, tmux scrollback, and — if the SSH client is misconfigured — the terminal title bar. The env-var approach concentrates the plaintext in the one file already locked down (`/opt/projekt-manager/.env` at mode 600 owned by `deploy`) with a clear removal ritual. Revisit once a secret manager is in place.

### Alternative D — External identity provider (SSO) from day one

Delegate authentication entirely, skip the admin-in-DB problem. Rejected: iteration 4 is explicitly single-tenant and pre-SSO. Adding an IdP is a meaningful architectural change scoped for a later iteration (spec §4.5 out-of-scope list). Not a walking-skeleton-sized step.

## Consequences

### Positive

- Fresh deploys are self-serviceable: set two env vars, deploy, log in, rotate password, scrub env vars, redeploy clean.
- The seed guard stays intact. Dev and prod do not share a "convenient but unsafe" user-creation path.
- Fail-closed partial-config behaviour prevents the silent-empty-DB failure mode that triggered this whole investigation.
- Idempotent by row count — container restarts with the env vars still in place are safe no-ops, so the removal step is a hygiene action rather than a correctness requirement.
- No new dependency or runtime surface. Startup gains one SQL `count(*)` and one conditional `INSERT`.
- Works identically on the first deploy and on a future `pgdata` volume rebuild (e.g., restore-from-backup to a fresh volume).

### Negative

- Plaintext credentials briefly sit in `/opt/projekt-manager/.env` on disk. Operator discipline mitigates; the intended window is minutes.
- The "remove vars after first login" step is a human protocol, not enforced by the system. Forgetting it leaves dormant credentials in `.env` that no longer do anything (bootstrap is a no-op once users exist) but still represent a leak surface if the file is later compromised. Documented in `.env.example` and `docs/ops/server-setup.md`, but still a protocol gap.
- Forced password rotation on first login is not implemented. The warning log and docs are the only enforcement. A future iteration may add a "must change on first login" user flag.
- Walking-skeleton-scoped. A production system with more than one operator will want a proper user management UI or SSO; this mechanism is a successor path, not a permanent answer.
- One more startup env var pair to remember during onboarding documentation — low cost, non-zero.

## References

- [#47](https://github.com/vlzware/Projekt-Manager/issues/47) — parent: HTTPS enforcement, exposed this gap
- [#57](https://github.com/vlzware/Projekt-Manager/issues/57) — implementation issue for this ADR
- [ADR-0005](0005-session-management-httponly-cookies.md) — session cookies (the thing that only makes sense once an admin can log in)
- [ADR-0006](0006-password-policy-nist-blocklist.md) — password policy this bootstrap password must pass
- [spec/index.md §4.5](../spec/index.md#45-authentication) — "Default admin account" row updated in this iteration
- [spec/data-model.md §7.2](../spec/data-model.md#72-seed-users) — seed user records, unchanged, still dev-only
- `src/server/start.ts` — `NODE_ENV=production → skip seed()` guard that this ADR preserves
