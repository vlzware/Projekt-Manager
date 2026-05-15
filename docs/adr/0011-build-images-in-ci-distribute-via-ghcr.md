# ADR-0011: Build app images in CI, distribute via GHCR

- **Status:** Accepted
- **Date:** 2026-04-09
- **Confidence:** High

## Context

ADR-0003 set the deployment topology (VPS + Docker Compose + GitHub Actions) but left the _location_ of image builds implicit. Previously, images were built on the VPS immediately before `docker compose up -d`.

With iteration 4's walking skeleton live, the resource math no longer holds:

| Component                           | RAM         |
| ----------------------------------- | ----------- |
| `app` container (limit)             | 512 MB      |
| `db` container (limit)              | 512 MB      |
| `storage` (MinIO) container (limit) | 512 MB      |
| `caddy` container (limit)           | 128 MB      |
| Docker daemon                       | ~200 MB     |
| Kernel + misc                       | ~500 MB     |
| **Baseline running stack**          | **~2.4 GB** |

VPS is 2 vCPU / 4 GB, leaving ~1.6 GB free at idle. `docker compose build app` peaks at ~1–1.5 GB (two `npm ci`, `tsc --noEmit` loading the full type graph, `vite build` running esbuild + rollup). Total ~3.6 GB of 4 GB — headroom collapses under any load. Realistic failure modes during a deploy:

- **OOM killer** picks a victim (app, postgres, or the build).
- **Swap thrashing** degrades the running app for the full 2–3 minute build.
- **Slow rollback**: rebuild still competes with the running stack.

Key forces:

- **Foundation quality.** CLAUDE.md §Principles rejects "document and accept" for foundation issues. A 2 vCPU / 4 GB VPS building its own image in production is not acceptable long-term.
- **Attended deploys.** Operator watches every deploy (solo dev, email on failure). The real need is to stop the deploy from disturbing the running stack, not automatic rollback.
- **Local/prod parity (ADR-0009).** VPS and dev machines run pinned Docker so `docker compose up` is deterministic. Moving builds to CI puts a CI runner in the build path — its Docker version is not under the same pin.
- **VPN-first (ADR-0008).** The app is only reachable via WG. A GitHub runner cannot reach the running app. CI only needs to reach GHCR, which is public.

## Decision

Build the production `app` image in GitHub Actions, push to GitHub Container Registry (`ghcr.io/vlzware/projekt-manager`), pull on the VPS during deploy.

**CI pipeline:**

- New `build-and-push` job in `.github/workflows/ci.yml`, runs on every push to `main` and `iteration/**`. Not path-filtered — a TypeScript change changes image contents without touching `Dockerfile`, so path filtering would ship stale images.
- `docker/login-action` authenticates to GHCR with the built-in `GITHUB_TOKEN` (no separate secret).
- `docker/build-push-action` with `cache-from: type=gha, cache-to: type=gha,mode=max` — warm builds ~10–15s.
- Job declares `packages: write` (default is `contents: read`).

**Tagging:**

- **Immutable**: `ghcr.io/vlzware/projekt-manager:sha-<commit>` — one per commit, the rollback target.
- **Moving**: `ghcr.io/vlzware/projekt-manager:<branch-slug>` — latest on each branch, human-friendly fallback.

**Compose topology:**

- `docker-compose.yml` (prod): `app` uses `image: ghcr.io/vlzware/projekt-manager:<tag>`, no `build:` — pure runtime descriptor.
- `docker-compose.dev.yml` (dev overlay): reintroduces `build: .` so local dev builds from source.
- Deploy: `scripts/deploy.sh` runs `docker compose pull app && docker compose up -d` (see [ADR-0012](0012-manual-pull-based-deploy-over-wireguard.md)).

**Image visibility:** private, matching the repo. Re-examine if any component goes beyond the WG tunnel.

**Retention:** GHCR built-in policy, keep last 20 untagged versions; branch-tagged versions retained until branch deletion.

## Alternatives Considered

- **Build on VPS (status quo).** Simplest topology, no registry dependency. Ruled out on the resource math — co-locating build peaks with the running stack on 2 vCPU / 4 GB is not sustainable. "Foundation quality is the point."
- **Upgrade the VPS.** Hetzner CX32 (4 vCPU / 8 GB, ~€8/month). Does not solve the co-location problem, just hides it behind more RAM.
- **Self-hosted runner inside WG.** No external registry dependency. Rejected: adds a second stateful host to operate and a self-hosted runner is itself security-sensitive (executes arbitrary workflow code). Zero savings — GHCR is free and already authenticated.
- **Docker Hub.** Pull-rate limits on unauthenticated users (eventually affects deploy), separate account/token, nothing GHCR does not give for a GitHub-hosted project.
- **S3/R2-backed OCI registry (Distribution or Harbor).** S3 is not an OCI registry; a self-run registry adds a stateful component for zero benefit at this scale.

## Consequences

### Positive

- VPS stops doing build work during deploys; live requests are undisturbed by `npm ci` / `tsc` spikes.
- Deploy wall-clock drops from ~3 minutes to ~15 seconds (build moved, not disappeared — but paid on capacity we have).
- Rollback is `docker compose pull app:sha-<old> && docker compose up -d` — seconds, not a VPS rebuild.
- Image history lives in GHCR — free audit trail, inspectable from any `docker pull` client.
- VPS-loss recovery is trivial: fresh host pulls the desired SHA from GHCR and comes up.
- Build and runtime concerns cleanly separated — VPS is purely a runtime host.

### Negative

- GHCR becomes a runtime dependency for _deploying_ (not serving — the running image keeps running if GHCR is down). GitHub Actions is already the critical path, so no new SPOF in practice.
- CI cold build adds ~1–2 minutes; warm builds ~10–15s. Net system cost is lower, but individual CI runs feel slightly slower.
- Every commit produces a new image even on small deltas. GHA caching absorbs the redundant work; retention handles stale tags.
- Image retention is a new operational concern — stale SHA tags accumulate without the built-in policy configured.
- CI runner's Docker version is not pinned under ADR-0009. Controlled drift: OCI images are portable across reasonably-versioned daemons; only the manifest format needs to match. Upcoming security audit decides whether this needs explicit mitigation.

## Dep lifecycle health (as of 2026-05-15)

| Dep                              | Status                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions                   | Active GitHub-managed platform | Action SHA pins live in `.github/workflows/`; Renovate maintains them under [ADR-0027](0027-continuous-dependency-updates-with-supply-chain-scanning.md). Pinned actions per [#187](https://github.com/vlzware/Projekt-Manager/issues/187): `actions/checkout`, `actions/setup-node`, `docker/build-push-action`, `docker/login-action`, `docker/setup-buildx-action`, `dorny/paths-filter`, `ludeeus/action-shellcheck` (all on current latest, no published advisories). |
| GitHub Container Registry (GHCR) | Active GitHub-managed service  | Free for public repos and OSS; private retention controlled via repo settings. No published deprecation path; exit ramp would be Docker Hub or self-hosted Distribution (alternatives in this ADR).                                                                                                                                                                                                                                                                        |

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md) — refines the CI/CD topology left open-ended there
- [ADR-0008: VPN-first network access](0008-vpn-first-network-access.md) — defines why a GitHub runner cannot reach the app directly
- [ADR-0009: Pin Docker Engine and Compose versions across environments](0009-pin-docker-versions-across-environments.md) — pin regime; this ADR introduces a controlled deviation for the CI builder
- [ADR-0012: Manual pull-based deploy over WireGuard](0012-manual-pull-based-deploy-over-wireguard.md) — replaces the distribution-to-host leg
