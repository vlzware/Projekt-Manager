# ADR-0009: Pin Docker Engine and Compose versions across environments

- **Status:** Accepted
- **Date:** 2026-04-07
- **Confidence:** High

## Context

The project runs Docker in three places: developer workstations, (future) CI Docker-build jobs, and the production VPS. Each host installs Docker from the official `download.docker.com/linux/ubuntu` apt repository, which always resolves to the current stable release.

During fresh VM setup on 2026-04-07, a version drift was discovered: the VPS (provisioned 2026-04-06) was running Docker 29.3.1, while a same-day fresh developer install pulled Docker 29.4.0. Both hosts had Compose plugin v5.1.1 by coincidence, but nothing enforced that. Under the default `unattended-upgrades` and `apt upgrade` behavior, either host can silently bump on its own schedule, and the drift compounds over time.

Key forces:

- **Local/prod parity is a load-bearing assumption.** ADR-0003 commits us to `docker compose up` producing identical stacks locally and in production. Silent version drift erodes that guarantee — a Compose-file feature or BuildKit syntax that works locally can fail on deploy.
- **Deploy pipeline builds on the VPS.** `deploy.yml` runs `docker compose build app` on the VPS (not on the CI runner), so the VPS Docker version is directly exposed to every deploy — and is the host most at risk of silent bumps from `unattended-upgrades`.
- **CI currently does not exercise Docker at all.** `ci.yml` uses GitHub Actions' native `services:` block for Postgres and never parses the Compose file or Dockerfile. Compose-file regressions surface only at deploy time. This gap is tracked in #51.
- **Solo operator.** There is no platform team to absorb surprise breakage from background upgrades. Determinism is worth more than automatic security patches at this scale.

## Decision

We will pin Docker Engine, Docker CLI, containerd, BuildKit plugin, and Compose plugin to explicit versions on every host, and place all five packages on apt hold. Version bumps are deliberate, lockstep operations across all environments.

**Pinned versions (as of 2026-04-07):**

| Package | Version |
|---|---|
| `docker-ce` | `5:29.3.1-1~ubuntu.24.04~noble` |
| `docker-ce-cli` | `5:29.3.1-1~ubuntu.24.04~noble` |
| `containerd.io` | `2.2.2-1~ubuntu.24.04~noble` |
| `docker-buildx-plugin` | `0.33.0-1~ubuntu.24.04~noble` |
| `docker-compose-plugin` | `5.1.1-1~ubuntu.24.04~noble` |

**Source of truth:** the production VPS is authoritative. Local environments match the VPS, not the other way around — so that developer environments reproduce production behaviour rather than leading it.

**Enforcement:** `sudo apt-mark hold` on all five packages on every host. Verified via `apt-mark showhold` after install and on each host audit.

**Upgrade procedure (lockstep):**

1. Review Docker's release notes and CHANGELOG for the target version.
2. On a non-production host first: `apt-mark unhold` → install the target version explicitly → `apt-mark hold` → run the full stack (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`) and smoke tests.
3. Repeat on remaining hosts, VPS last.
4. Update this ADR with the new pinned versions and the date.

## Alternatives Considered

### Track `latest` (status quo before this decision)

Install with `apt-get install docker-ce` (no version) and let `apt upgrade` pull bumps automatically. Main advantage: security patches land without operator action. Ruled out because it silently breaks the local/prod parity that ADR-0003 depends on, and because the solo operator has no monitoring in place to detect when hosts drift apart.

### Snap-based Docker

`sudo snap install docker` — updates are managed by snapd on its own cadence. Main advantage: no manual pin maintenance. Ruled out because the snap package is not published by Docker Inc., lags upstream releases, has a history of cgroup and socket-path quirks that break Compose v2 healthchecks, and the update cadence is opaque — trading explicit drift for implicit drift.

### Ubuntu's `docker.io` package

`sudo apt-get install docker.io` from the Ubuntu archive. Main advantage: comes from the distribution, eligible for Ubuntu security updates. Ruled out for the same reasons given in ADR-0003 Phase 4: lags upstream on security patches, does not include the Compose V2 plugin we depend on.

### Pin only Docker Engine, leave plugins floating

Pin `docker-ce` and `docker-ce-cli` but let `containerd.io`, `docker-buildx-plugin`, and `docker-compose-plugin` track latest. Main advantage: less maintenance surface. Ruled out because Compose-file semantics and BuildKit behaviour live in those plugins — exactly the layer this ADR is trying to stabilise.

## Consequences

### Positive

- `docker compose` behaviour is deterministic across local, VPS, and any future hosts
- Silent `apt upgrade` drift is eliminated on the package layer
- Upgrade events become explicit, reviewable changes — easy to correlate with regressions
- Reproducing production incidents locally is reliable

### Negative

- Docker security patches do not apply automatically — the operator must track Docker advisories and pull fixes manually
- Upgrade is a coordinated multi-host procedure; forgetting one host reintroduces drift
- This ADR itself must be kept current — the pinned version table becomes stale if not updated on every bump
- Adds a manual step to fresh-host setup (install explicit version + hold, instead of just `apt-get install docker-ce`)

### Mitigations

- Tracking mechanism for Docker security advisories is an open decision (#52). Until chosen, manually check Docker release notes before any deliberate version bump, and treat that as the interim backstop.
- `apt-mark showhold` is part of the post-install verification on every host (see `docs/ops/server-setup.md` Phase 4)
- The upgrade procedure above is also documented in `docs/ops/server-setup.md` for operational reference

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md)
- [docs/ops/server-setup.md](../ops/server-setup.md) — Phase 4 (Docker install)
- Docker apt repository: https://download.docker.com/linux/ubuntu
- #51 — Related gap: CI does not currently build the Docker image or parse the Compose file. Compose-file regressions only surface at deploy time.
- #52 — Open decision: mechanism for tracking Docker security advisories under the version-pinning regime.
