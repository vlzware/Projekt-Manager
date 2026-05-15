# Dependency management

How the project tracks, updates, and audits external deps. Rationale: [ADR-0027](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md).

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

## Quarterly lifecycle review

**Last performed:** _not yet_ — first review due **2026-08-15**.

For each strategic dep below, check (≤5 min each):

- **deps.dev / Snyk Advisor** — last release date, maintainer count.
- **GitHub repo** — archived flag, issue triage, license file (BSL/SSPL/Elastic relicensings).
- **Renovate dashboard** — stuck/abandoned PRs on the dep.

When something changes (archive, relicense, bus-factor drop), update the relevant ADR's lifecycle table and open an issue. Do not panic-migrate — same week is fine, same month usually is too.

**Strategic deps:**

| Domain              | Deps                                                                               | Source of truth                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language + frontend | `typescript`, `react`, `vite`, `zustand`, `date-fns`, `vitest`, `@playwright/test` | [ADR-0002](../adr/0002-tech-stack-typescript-react-vite-zustand.md)                                                                                      |
| Backend             | `fastify`, `drizzle-orm`, `pg`                                                     | [ADR-0004](../adr/0004-backend-stack-fastify-drizzle-node-postgres.md)                                                                                   |
| Container stack     | Docker Engine, containerd, BuildKit, Compose plugin                                | [ADR-0009](../adr/0009-pin-docker-versions-across-environments.md)                                                                                       |
| Base images         | `node:*-alpine`, `postgres:17-alpine`, `caddy:*`                                   | `Dockerfile*`, `docker-compose*.yml`                                                                                                                     |
| Caddy + plugin      | `caddy`, `caddy-dns/cloudflare`                                                    | [ADR-0003](../adr/0003-deployment-infrastructure-vps-docker-compose-github-actions.md)                                                                   |
| CI/CD platform      | GitHub Actions, GHCR                                                               | [ADR-0011](../adr/0011-build-images-in-ci-distribute-via-ghcr.md)                                                                                        |
| Storage SaaS        | Backblaze B2, Cloudflare R2                                                        | [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md), [ADR-0020](../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) |
| Crypto tooling      | `age`                                                                              | [ADR-0012](../adr/0012-manual-pull-based-deploy-over-wireguard.md)                                                                                       |
| LLM gateway         | OpenRouter + pinned model                                                          | [ADR-0016](../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md)                                                                            |
| Invoice pipeline    | `@cantoo/pdf-lib`, `xmllint-wasm`, `fast-xml-parser`, `archiver`                   | [ARCHITECTURE.md § Invoices Module](../../ARCHITECTURE.md#dep-lifecycle-health-as-of-2026-05-15)                                                         |
| VPN                 | WireGuard kernel + clients                                                         | [ADR-0008](../adr/0008-vpn-first-network-access.md)                                                                                                      |
| Storage SDK         | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`                              | [ADR-0022](../adr/0022-binary-storage-b2-compliance-object-lock.md)                                                                                      |

After the review, update the "Last performed" date above.

## Adopting a new dep

Any ADR that commits to a specific named external dep must include a `## Dep lifecycle health (as of YYYY-MM-DD)` section ([ADR-0027 §Decision.3](../adr/0027-continuous-dependency-updates-with-supply-chain-scanning.md#3-lifecycle-health-entry-on-dep-introducing-adrs--quarterly-review)). For non-ADR-worthy picks (small libs at implementation time), the same check applies — the record goes in `ARCHITECTURE.md` or the relevant design doc.

Minimum at adoption time: last release date, license, maintainer count or archived flag, deps.dev link.

## Files

- `.github/renovate.json` — groups, schedule, auto-merge rules _(not yet authored — follow-up PR)_
- `.github/workflows/ci.yml` — OSV-Scanner + Trivy steps _(not yet wired — follow-up PR)_
