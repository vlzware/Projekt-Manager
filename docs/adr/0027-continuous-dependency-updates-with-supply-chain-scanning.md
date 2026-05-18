# ADR-0027: Continuous dependency updates with supply-chain scanning

- **Status:** Accepted
- **Date:** 2026-05-15
- **Confidence:** High

## Context

Dependency hygiene has so far been a **manual audit** triggered by guilt rather than schedule. The most recent pass ([#187](https://github.com/vlzware/Projekt-Manager/issues/187), 2026-05-15) accumulated in under two months:

- ~25 patch/minor bumps batched into one omnibus PR
- One ESLint major cluster (`eslint` 9→10, `@eslint/js`, `globals` 14→17, `typescript-eslint`, `lint-staged` 16→17)
- One Node base-image bump (3 CVEs)
- One Docker Engine bump (2 CVEs, including in-container privesc)
- Two **non-drop-in migrations** carved into separate issues:
  - [#191](https://github.com/vlzware/Projekt-Manager/issues/191) — `minio/minio` upstream-archived 2026-04-25, caught ~3 weeks late
  - [#192](https://github.com/vlzware/Projekt-Manager/issues/192) — `libxmljs2` README literally `# NO LONGER MAINTAINED`, caught only by this audit
- Two driver-level switches (`pdf-lib` → `@cantoo/pdf-lib`, `pdf-parse` → `unpdf`)
- A patch deletion (`@aws-sdk+xml-builder` patch rendered obsolete by upstream rewrite)

This pattern is structurally fragile in three ways:

1. **Batching correlates risk.** A regression in one of 25 bumps becomes a bisect through the whole batch. Each bump's CI signal is invisible.
2. **CVE time-to-merge is weeks, not hours.** The Caddy admin-socket and FastCGI advisories, the Docker `containerd` DoS, and the MinIO session-policy privesc all sat unpatched until a human noticed.
3. **Dying upstreams surface late.** MinIO's archive flag flipped on a Saturday (2026-04-25); the project found out via a bored Wednesday audit three weeks later. The agent that originally recommended MinIO (during initial stack selection) did **not** check upstream lifecycle — a known LLM failure mode. The fix is a process bar, not a "be more careful" rule.

Constraints:

- **No commercial budget.** Snyk / Mend / Sonatype IQ tiers are out of scope for an LLM-driven solo project.
- **Single-tenant dev/eval environment.** SLSA / SBOM / `cosign` provenance are appropriate when shipping to enterprise customers or distributing artifacts publicly; the trigger for adopting them is going multi-tenant or third-party-distributing, neither of which is the current state.
- **Test confidence is high.** Unit + integration + Playwright E2E gates every PR. Auto-merge on green CI is a credible default for non-major bumps.
- **Dependabot Alerts is already on** at the repo Security tab.

Forces:

- The standard commercial baseline for a single-tenant Node project is **Renovate or Dependabot for updates + a vuln scanner in CI + ADR-discipline at dep adoption time**. We currently have one of three (Alerts).
- The MinIO failure mode is not a tooling gap alone — it is a **decision-time discipline gap**: no record of "what was the upstream health of MinIO on the day we adopted it." Adding that record creates a re-evaluation trigger that does not depend on someone remembering.

## Decision

We will adopt **three coupled changes**:

### 1. Renovate as the primary update bot

`.github/renovate.json` with:

- **Schedule:** weekly window (e.g. `before 9am on monday`) for routine bumps. Vulnerability PRs bypass the schedule.
- **Grouping:** lockstep clusters get one PR — AWS SDK family, ESLint cluster (`eslint` + `@eslint/js` + `globals` + `typescript-eslint`), Vitest pair (`vitest` + `@vitest/coverage-v8`), React pair, Fastify family, Drizzle pair.
- **Per-major-version PRs.** No grouping across majors; each major bump gets its own PR with the changelog inline.
- **Auto-merge** for patch + minor when CI is green, **except** on the lockstep clusters above (group bumps get human review even if minor — easier to read changelog deltas in one place).
- **Lockfile maintenance** PR weekly to bound transitive drift.
- **Managers:** `npm`, `dockerfile`, `docker-compose`, `github-actions`, `regex` for the Caddy plugin SHA + Alpine apk pins + `download.docker.com` package versions.

Dependabot Alerts stays on at the GH Security tab — it remains the CVE notification surface; Renovate is the **action** surface.

### 2. Supply-chain scanning in CI (blocking on HIGH/CRITICAL)

- **OSV-Scanner** (`google/osv-scanner-action`) — scans the npm tree against the OSV database. Free, OSS, broader DB than `npm audit`. Blocks merge on `HIGH` / `CRITICAL`.
- **Trivy** (`aquasecurity/trivy-action`) — scans the built Docker image, including OS packages (`apk`, `apt`) that OSV-Scanner can't see. Same blocking rule. Runs only on PRs that touch image-affecting paths (`Dockerfile*`, `package.json`, `package-lock.json`).

Exceptions to blocking go in a documented allowlist with a review trigger (the pattern from the superseded [ADR-0007](0007-suppress-esbuild-dev-server-advisory.md) is the right shape).

### 3. Lifecycle-health entry on dep-introducing ADRs + quarterly review

- The `vv-adr` skill now requires a `## Dep lifecycle health (as of YYYY-MM-DD)` section on any ADR that commits to a specific named external dep (npm package, container image, SaaS service, source-built binary). Pattern/policy ADRs omit it — for this codebase the excluded set is **0001, 0005, 0006, 0007 (superseded), 0010, 0013, 0014, 0015, 0017, 0018, 0019, 0021, 0023, 0025**. New ADRs apply the same test: if no named external dep is committed, omit the section. If the ADR delegates lib choice to a design doc (e.g., `ARCHITECTURE.md`), the table lives in the design doc — one source of truth per dep.
- ADRs 0002–0026 are retrofitted in the same change as this ADR (excluding the superseded 0007 and the pattern-only ones). ADR-0009's existing version table doubles as its lifecycle surface. ADR-0008's prose maintenance notes are reshaped into a structured table.
- A **quarterly strategic-dep review** walks the headline deps (framework, ORM, storage SaaS, base images, build tooling) and asks: alive? funded? still our best option? exit ramp documented? Outcomes feed superseding ADRs when warranted. Tracked in [docs/ops/dep-management.md](../ops/dep-management.md).

## Alternatives Considered

### Dependabot-only as the primary update bot

GitHub-native, already half-configured (Alerts on). Ruled out: weaker grouping (no expression-based clusters across ecosystems), no Docker-tag regex manager for arbitrary files (Caddy plugin SHA, apk pins, `download.docker.com` package list), no `lockFileMaintenance` equivalent, no schedule windows. Renovate covers the project's mixed-ecosystem pinning surface; Dependabot would leave half of [#187](https://github.com/vlzware/Projekt-Manager/issues/187)'s scope outside automation. Dependabot Alerts remains on for the CVE notification surface — the two cooperate.

### Manual audits tightened to monthly cadence

The status quo with more discipline. Ruled out: the failure mode is structural, not effort-based. Even monthly audits produce a batched omnibus PR that hides individual signal; CVE time-to-merge stays in weeks. The MinIO archival timing is the proof — a once-a-month audit would still have caught it three weeks late.

### Commercial SCA (Snyk Open Source / Mend / Sonatype IQ)

Best dashboards, license compliance, supply-chain anomaly detection. Ruled out for the current stage: paid tier is not justifiable against an OSS-tier alternative (Renovate + OSV-Scanner + Trivy) that covers the same primary use cases. Revisit if the project distributes artifacts to enterprise customers — that is the trigger that justifies the cost.

### SBOM + provenance now (`syft` + `cosign`)

Generate CycloneDX SBOMs on each release, sign images with `cosign`, target SLSA Level 2+. Ruled out for now: appropriate when an external party consumes the artifact (enterprise customer, regulated industry, distro/registry publishing). The current artifact has one consumer — the VPS — and is built in CI. Recorded as a future-work seam for the multi-tenant / public-distribution transition.

### `npm audit` in CI only

The lightest possible option. Ruled out: covers only the npm tree, no OS-package or container coverage, advisory database lags GHSA, noise floor is high (transitive devDeps trigger constantly). The superseded ADR-0007 is direct evidence of the npm-audit-only path failing in practice.

## Consequences

### Positive

- **Continuous, individually-tested bumps.** Each Renovate PR gets its own CI signal. Regressions surface against the single bump that caused them.
- **CVE time-to-merge measured in hours.** Vulnerability PRs bypass schedule; with auto-merge on green CI for patch/minor, the median CVE patch lands the same day it is published.
- **Dying-upstream signal at decision time.** The mandatory lifecycle-health section converts "the agent recommended MinIO" into "the agent recommended MinIO; here is its archive flag, last release, license, deps.dev score at adoption time." A future reader has an evaluable trail.
- **Quarterly review catches BSL/SSPL relicensings and bus-factor erosion** without depending on someone happening to notice during routine work.
- **Existing artifacts cooperate.** Dependabot Alerts is unchanged. ADR-0009's Docker version table doubles as the lifecycle table for that ADR's deps.
- **Aligned with the project's "refuse to serve" principle** — CVE scanning in CI blocks the merge, not deferring it to a runtime probe.

### Negative

- **PR queue volume.** A weekly window with grouping should land 3–8 PRs/week in steady state. The "weekly wrangler" hat is ~30 min/week.
- **Auto-merge depends on CI confidence.** If Playwright E2E flakes, auto-merge produces false-green merges. No flake-quarantine practice is documented today — explicit gap. Interim mitigation: auto-merge stays off for grouped/major PRs (the highest-risk class). Threshold rule for tuning in a future iteration: **disable auto-merge for the affected suite if E2E flake rate exceeds 5% over the last 20 PRs**; defaults are a placeholder until we have a quarter of CI history to calibrate against.
- **Renovate config drift.** A `.github/renovate.json` that goes stale (new dep types, ecosystem changes) silently degrades coverage. Mitigated by the quarterly review explicitly checking the config.
- **OSV-Scanner false positives** for advisories on dead code paths (cf. the original ADR-0007 case). Mitigated by a structured allowlist — never a blanket `--omit=dev`. Every entry in `osv-scanner.toml` (and the equivalent in `.trivyignore`) MUST carry:
  - `id` — the advisory identifier (`GHSA-…`, `CVE-…`, or `OSV-…`).
  - `reason` — why this advisory doesn't apply here (dead code path, mitigated upstream, exploitation precondition unmet, …) **including the GitHub handle of the person who added the entry** (osv-scanner.toml has no dedicated `owner` field; for `.trivyignore` the handle goes in the `#` comment above the line).
  - `ignoreUntil` — ISO date, at most **90 days from creation**, forces a re-review. For `.trivyignore` use the `exp:YYYY-MM-DD` suffix.

  See [docs/ops/dep-management.md § Allowlist (OSV-Scanner + Trivy)](../ops/dep-management.md#allowlist-osv-scanner--trivy) for example entries.

### Operational

Implementation ships in this ADR's PR:

- `.github/renovate.json` — schedule, grouping, auto-merge rules, manager set.
- `.github/workflows/ci.yml` — OSV-Scanner step + Trivy step added to the existing CI workflow; both block merge on HIGH / CRITICAL.
- `.github/workflows/security-scheduled.yml` — nightly OSV-Scanner run against `main` so newly-published advisories surface without waiting for a PR.
- `osv-scanner.toml` (repo root) — allowlist file; empty on landing, schema documented in `docs/ops/dep-management.md`.
- `.trivyignore` (repo root) — allowlist file for Trivy; empty on landing, same schema discipline.
- [docs/ops/dep-management.md](../ops/dep-management.md) — runbook (first-run setup, weekly wrangler, quarterly review, allowlist schema).
- The `vv-adr` skill template is updated; retrofits to the existing ADRs in the included set land in the same change as this ADR.
- No env-var or schema impact.

## Dep lifecycle health (as of 2026-05-15)

Renovate, OSV-Scanner, and Trivy are the adopted _tooling_; the choice is reversible (move to Dependabot-only or to commercial SCA later). Concrete tool-version pinning lives in `.github/workflows/*.yml` and `.github/renovate.json` and is tracked by Renovate's own self-update path.

| Dep                                | Last release     | License    | Maintainership                   | Notes                                                                                |
| ---------------------------------- | ---------------- | ---------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Renovate (`renovatebot/renovate`)  | active, weekly   | AGPL-3.0   | Mend, very active                | [deps.dev](https://deps.dev/npm/renovate) — industry default; self-hosted optional   |
| OSV-Scanner (`google/osv-scanner`) | active           | Apache-2.0 | Google OSS Security Team, active | [OSV-Scanner repo](https://github.com/google/osv-scanner) — backed by OSV.dev DB     |
| Trivy (`aquasecurity/trivy`)       | active, frequent | Apache-2.0 | Aqua Security, very active       | [Trivy repo](https://github.com/aquasecurity/trivy) — de-facto OSS container scanner |

## References

- [ADR-0007 (superseded)](0007-suppress-esbuild-dev-server-advisory.md) — `npm audit`-only baseline that proved insufficient; the suppression pattern is reused for OSV-Scanner allowlists.
- [ADR-0009](0009-pin-docker-versions-across-environments.md) — Docker version pinning; its existing version table is the lifecycle-health surface for the Docker stack.
- [Issue #187](https://github.com/vlzware/Projekt-Manager/issues/187) — the omnibus audit this ADR is responding to.
- [Issue #191](https://github.com/vlzware/Projekt-Manager/issues/191) — MinIO archival; the canonical failure case for "adopted-already-dying."
- [Issue #192](https://github.com/vlzware/Projekt-Manager/issues/192) — libxmljs2 unmaintained replacement.
- [docs/ops/dep-management.md](../ops/dep-management.md) — runbook complement: cadence, wrangler procedure, lifecycle-review process.
- [Renovate docs](https://docs.renovatebot.com/) — configuration reference.
- [OSV-Scanner](https://google.github.io/osv-scanner/) — scanner + database.
- [Trivy](https://trivy.dev/) — container/image scanner.
- [deps.dev](https://deps.dev/) — Google's dep metadata aggregator (the canonical "is this package alive" lookup).
