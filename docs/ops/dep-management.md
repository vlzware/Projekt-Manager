# Dependency management

How the project tracks, updates, and audits external deps. Rationale: [ADR-0027](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md).

## First-run setup

Renovate is a GitHub App. Until installed and onboarded, the `.github/renovate.json` in the repo does nothing.

1. **Install the Renovate App** for `vlzware/Projekt-Manager` from [github.com/apps/renovate](https://github.com/apps/renovate) — choose **Select repositories** and pick this repo only.
2. **Merge the onboarding PR.** On first scan Renovate opens a "Configure Renovate" PR; per the [Renovate docs](https://docs.renovatebot.com/getting-started/installing-onboarding/), no further PRs are raised until it lands. Sanity-check that it picked up `.github/renovate.json` and then merge.
3. **Enable auto-merge at the repo level.** Repo Settings → General → "Allow auto-merge" must be checked, otherwise `automerge: true` in the config silently no-ops.
4. **Tighten branch protection on `main`.** Required status checks must list the **CI job names** (not step names — GitHub branch protection matches job-level checks): `check` (always — runs OSV-Scanner + tests + lint), `docker` (runs Trivy image/secret/IaC scans on image-touching PRs), and `build-and-push` (post-merge backstop image scan + push to GHCR). Without these, Renovate's auto-merge bypasses the very safety net this ADR adds.
5. **Pin the Dependency Dashboard issue.** Renovate auto-creates an issue titled "Dependency Dashboard" listing queue state; pin it so the weekly wrangler can find it without searching.

## Cadence

| Trigger                                         | Result                               | Latency                |
| ----------------------------------------------- | ------------------------------------ | ---------------------- |
| Renovate weekly window (Mon 09:00 Europe/Sofia) | Routine bumps as individual PRs      | ~30 min/week wrangler  |
| Dependabot Alert                                | Renovate opens a vuln PR out-of-band | Hours from publication |
| OSV-Scanner / Trivy CI fail                     | PR merge blocked                     | Per-PR                 |
| Quarterly review                                | Walk strategic-dep list (below)      | ~1 hour, 4×/year       |

## Weekly wrangler

1. Open the Renovate dashboard issue — queue state at a glance.
2. **Auto-merged PRs** (patch/minor + green CI) need no action; spot-check for surprises.
3. **Grouped PRs** (AWS SDK / ESLint cluster / Vitest pair / React pair / Fastify family / Drizzle pair): read combined changelog, merge.
4. **Major PRs**: read upstream migration guide, run `npm test` + `npm run test:e2e` locally on the bump branch, merge.
5. **Lockfile maintenance** PR: merge if green.
6. Red CI: triage the failure, patch or revert.

## CVE handling

- **High/Critical** — bypass schedule; merge on green CI even off-hours.
- **Medium/Low** — roll into the weekly batch.
- **False-positive on dead code** (cf. the original [ADR-0007](../adr/0007-suppress-esbuild-dev-server-advisory.md) case): add the advisory to the OSV-Scanner allowlist with a documented review trigger. Never `--omit=dev` blanket-suppress.

### Allowlist (OSV-Scanner + Trivy)

Allowlist files: `osv-scanner.toml` (npm + git deps) and `.trivyignore` (container image scan), both at the repo root.

Per [ADR-0027 §Negative](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#negative), every entry MUST carry:

- **`id`** — advisory identifier (`GHSA-…`, `CVE-…`, or `OSV-…`).
- **`reason`** — why the advisory doesn't apply (dead code path, mitigated upstream, exploit precondition unmet, …) **plus the GitHub handle of the person adding the entry**. The osv-scanner.toml schema has no dedicated `owner` field, so the handle goes inside `reason`; for `.trivyignore` it goes in the `#` comment above the line.
- **`ignoreUntil`** — ISO date, **at most 90 days from creation**. Forces a re-review; an expired entry stops suppressing and the advisory blocks CI again. For `.trivyignore` use the `exp:YYYY-MM-DD` suffix.

If any of the three is missing, the entry is illegitimate — delete it and let CI fail until a real entry is written. Per [CLAUDE.md "refuse to serve" principle](../../CLAUDE.md#principles), the correct response to an undocumented suppression is to remove it, not to keep it "for now."

**`osv-scanner.toml` example entry:**

```toml
[[IgnoredVulns]]
id = "GHSA-67mh-4wv8-2f99"
ignoreUntil = 2026-08-15  # <= 90 days from add date 2026-05-18
reason = "esbuild dev-server only; prod build invokes the bundler API, not the server. Added by @vlzware."
```

**`.trivyignore` example entry:**

```text
# CVE on libfoo (image base layer) — exploitation requires inbound TCP on 9000, our image binds only 8080.
# Added by @vlzware. Re-review by 2026-08-15.
CVE-2026-12345 exp:2026-08-15
```

## Quarterly lifecycle review

**Last performed:** _not yet_ — first review due **2026-08-17** (Monday; 2026-08-15 falls on a Saturday, aligned with the weekly wrangler cadence).

For each strategic dep below, check (≤5 min each):

- **deps.dev / Snyk Advisor** — last release date, maintainer count.
- **GitHub repo** — archived flag, issue triage, license file (BSL/SSPL/Elastic relicensings).
- **Renovate dashboard** — stuck/abandoned PRs on the dep.

When something changes (archive, relicense, bus-factor drop), update the relevant ADR's lifecycle table and open an issue. Do not panic-migrate — same week is fine, same month usually is too.

**Strategic deps:**

A dep is "strategic" if it is load-bearing for security, runtime correctness, or is a major framework / language-level dep. Dev-convenience tooling (e.g., `concurrently`, `husky`) is not listed.

| Domain                   | Deps                                                                                            | Source of truth                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language + frontend      | `typescript`, `react`, `react-dom`, `vite`, `zustand`, `date-fns`, `vitest`, `@playwright/test` | [ADR-0002](../adr/0002-tech-stack-typescript-react-vite-zustand.md)                                                                                                                            |
| Frontend routing         | `react-router-dom` (v7, major churn surface)                                                    | [ADR-0002](../adr/0002-tech-stack-typescript-react-vite-zustand.md) — referenced in ARCHITECTURE.md routing section                                                                            |
| Backend                  | `fastify`, `drizzle-orm`, `pg`                                                                  | [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md)                                                                                                                         |
| HTTP security middleware | `@fastify/cookie`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static` | [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md), [ADR-0005](../adr/0005-session-management-httponly-cookies.md) — perimeter; CVEs here are session / CSRF / DoS classes |
| Schema validation        | `zod`                                                                                           | Input-validation default per [CLAUDE.md Principles](../../CLAUDE.md#principles); on the security perimeter for every mutating endpoint                                                         |
| Auth crypto              | `bcryptjs`, `web-push`                                                                          | [ADR-0006](../adr/0006-password-policy-nist-blocklist.md) for password hashing; `web-push` ships the VAPID + AES-GCM stack for push notifications                                              |
| Container stack          | Docker Engine, containerd, BuildKit, Compose plugin                                             | [ADR-0009](../adr/0009-pin-docker-versions-across-environments.md)                                                                                                                             |
| Base images              | `node:*-alpine`, `postgres:17-alpine`, `caddy:*`                                                | `Dockerfile*`, `docker-compose*.yml`                                                                                                                                                           |
| Caddy + plugin           | `caddy`, `caddy-dns/cloudflare`                                                                 | [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md)                                                                                                         |
| CI/CD platform           | GitHub Actions, GHCR                                                                            | [ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md)                                                                                                                              |
| Storage SaaS             | Backblaze B2, Cloudflare R2                                                                     | [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md), [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)                                       |
| Crypto tooling           | `age`                                                                                           | [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)                                                                                                                             |
| LLM gateway              | OpenRouter + pinned model                                                                       | [ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md)                                                                                                                  |
| Invoice pipeline         | `@cantoo/pdf-lib`, `xmllint-wasm`, `fast-xml-parser`, `archiver`                                | [ARCHITECTURE.md § Invoices Module](../../ARCHITECTURE.md#dep-lifecycle-health-as-of-2026-05-15)                                                                                               |
| Native image processing  | `sharp`                                                                                         | Native libvips bindings; recurring CVE surface (image bombs, integer overflow); used in attachment pipeline                                                                                    |
| PDF parsing              | `unpdf`                                                                                         | Replacement for the abandoned `pdf-parse`; on the email/invoice ingestion path                                                                                                                 |
| Build / dev runtime      | `esbuild` (server bundle in `build:server`), `tsx` (dev / e2e server entry)                     | `package.json` scripts; `esbuild` ships the production server artifact, `tsx` is the dev-time TS loader                                                                                        |
| VPN                      | WireGuard kernel + clients                                                                      | [ADR-0008](../adr/0008-vpn-first-network-access.md)                                                                                                                                            |
| Storage SDK              | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`                                           | [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)                                                                                                                            |

After the review, update the "Last performed" date above.

## Adopting a new dep

Any ADR that commits to a specific named external dep must include a `## Dep lifecycle health (as of YYYY-MM-DD)` section ([ADR-0027 §Decision.3](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#3-lifecycle-health-entry-on-dep-introducing-adrs--quarterly-review)). For non-ADR-worthy picks (small libs at implementation time), the same check applies — the record goes in `ARCHITECTURE.md` or the relevant design doc.

Minimum at adoption time: last release date, license, maintainer count or archived flag, deps.dev link.

## Files

- `.github/renovate.json` — Renovate config: schedule (`before 9am on monday` Europe/Sofia), grouping clusters, auto-merge rules, manager set (`npm` + `dockerfile` + `docker-compose` + `github-actions` + `regex`).
- `.github/workflows/ci.yml` — adds OSV-Scanner step (every PR) and Trivy step (PRs touching image-affecting paths). Both block merge on HIGH / CRITICAL.
- `.github/workflows/security-scheduled.yml` — nightly OSV-Scanner run against `main` so newly-published advisories surface without waiting for a PR.
- `osv-scanner.toml` — allowlist for OSV-Scanner (npm + git deps). Schema in [§Allowlist](#allowlist-osv-scanner--trivy) above.
- `.trivyignore` — allowlist for Trivy (container image scan). Same schema discipline; comments carry the owner handle.
