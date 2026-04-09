# ADR-0011: Build app images in CI, distribute via GHCR

- **Status:** Accepted
- **Date:** 2026-04-09
- **Confidence:** High

## Context

ADR-0003 established the deployment topology (VPS + Docker Compose + GitHub Actions) but left the *location* of image builds implicit. In practice, `deploy.yml` runs `docker compose build app` over SSH on the VPS itself, immediately before `docker compose up -d`.

With iteration 4's walking skeleton now live and the deploy path exercised regularly, the resource math of this choice no longer holds:

| Component | RAM |
|---|---|
| `app` container (limit) | 512 MB |
| `db` container (limit) | 512 MB |
| `storage` (MinIO) container (limit) | 512 MB |
| `caddy` container (limit) | 128 MB |
| Docker daemon | ~200 MB |
| Kernel + misc | ~500 MB |
| **Baseline running stack** | **~2.4 GB** |

The VPS is 2 vCPU / 4 GB, leaving ~1.6 GB free at idle. A `docker compose build app` peaks at ~1–1.5 GB (two `npm ci` invocations, `tsc --noEmit` loading the full type graph, and `vite build` running esbuild + rollup). Sum: ~3.6 GB of 4 GB — headroom collapses under any load. The realistic failure modes during a deploy window are:

- **OOM killer** selects a victim among running containers (app or postgres) or the build itself
- **Swap thrashing** degrades the running app for the full 2–3 minute build window
- **Slow rollback**: rebuilds also compete with the running stack, so recovery from a bad deploy pays the same cost

Key forces:

- **Foundation quality.** CLAUDE.md §Principles rejects "document and accept" for foundation-level issues. A 2 vCPU / 4 GB VPS building its own image in production is not an acceptable long-term posture.
- **Attended deploys.** The operator currently watches every deploy (solo dev, email notifications on failure). Automatic rollback solves a problem we do not have; what we actually need is to stop the deploy from disturbing the running stack in the first place.
- **Local/prod parity from ADR-0009.** The VPS and developer machines run pinned Docker versions so `docker compose up` is deterministic. Moving builds to CI puts a CI runner in the build path — its Docker version is not under the same pin regime.
- **ADR-0008 (VPN-first).** The app is only reachable via the WireGuard tunnel. A GitHub-hosted runner cannot reach the running app. Building in CI does not change this — CI only needs to reach GHCR, which is public internet.

## Decision

We will build the production `app` image in GitHub Actions, push it to GitHub Container Registry (`ghcr.io/vlzware/projekt-manager`), and pull it on the VPS during deploy.

**CI pipeline:**

- New `build-and-push` job in `.github/workflows/ci.yml`, runs on every push to `main` and `iteration/**`. Not path-filtered — a TypeScript change does not touch `Dockerfile` but still changes image contents, so path filtering would silently ship stale images.
- `docker/login-action` authenticates to GHCR using the workflow's built-in `GITHUB_TOKEN` (no separate secret to manage).
- `docker/build-push-action` with `cache-from: type=gha, cache-to: type=gha,mode=max` — warm builds complete in ~10–15 seconds.
- Workflow declares `packages: write` permission at the job level (default is `contents: read` only).

**Tagging:**

- **Immutable**: `ghcr.io/vlzware/projekt-manager:sha-<commit>` — one per commit, the rollback target
- **Moving**: `ghcr.io/vlzware/projekt-manager:<branch-slug>` — points to the latest commit on each branch, used by `deploy.yml`

**Compose topology:**

- `docker-compose.yml` (prod): the `app` service uses `image: ghcr.io/vlzware/projekt-manager:<tag>` with no `build:` directive — it is purely a runtime descriptor
- `docker-compose.dev.yml` (dev overlay): reintroduces `build: .` so local development still builds from source
- `deploy.yml`: `docker compose pull app && docker compose up -d` replaces `docker compose build app && docker compose up -d`

**Image visibility:** private, matching the repo. Re-examine if any component needs to be distributed beyond the WG tunnel.

**Retention:** GHCR built-in policy, keep last 20 untagged versions; all branch-tagged versions retained until branch deletion.

## Alternatives Considered

### Build on VPS (status quo)

The simplest topology, self-contained, no external registry dependency. Ruled out on the resource math above: co-locating build peaks with the running stack on a 2 vCPU / 4 GB host is not sustainable once the stack carries any real load. "Foundation quality is the point" (CLAUDE.md) rules out accepting this as a permanent posture.

### Upgrade the VPS

Move to a larger instance (e.g., Hetzner CX32 at 4 vCPU / 8 GB for ~€8/month). Ruled out because it does not solve the underlying issue — build still competes with runtime, just with more headroom — and it hides deploy-time contention behind extra RAM instead of eliminating it. The problem is the co-location of build and serve, not the absolute scale.

### Self-hosted GitHub Actions runner inside the WG tunnel

A dedicated machine inside WG hosts a runner, builds the image, and SSHs into the VPS (also inside WG) without needing an external registry. Main advantage: no runtime registry dependency; the whole pipeline lives inside the tunnel. Ruled out because it adds a second host to operate (OS patches, Docker install, security hardening), a self-hosted runner is a security-sensitive component (executes arbitrary workflow code), and the savings over GHCR are zero — GHCR is free and authenticated by a token we already have.

### Docker Hub instead of GHCR

Push to `docker.io/vlzware/projekt-manager`. Main advantage: the most well-known public registry. Ruled out because Docker Hub enforces pull-rate limits for unauthenticated users (which would eventually affect the deploy path), requires a separate account and token to manage, and offers nothing GHCR does not for a GitHub-hosted project.

### S3/R2-backed OCI registry (self-run Distribution or Harbor)

Store image layers in object storage with a self-run registry front-end. Ruled out immediately: S3 is not an OCI registry on its own, and running a registry server adds a stateful component to operate for zero benefit at this scale.

## Consequences

### Positive

- The VPS stops doing build work during deploys; live requests are undisturbed by `npm ci` / `tsc` CPU + RAM spikes
- Deploy wall-clock time drops from ~3 minutes to ~15 seconds (the build moved, not disappeared — but the cost is paid on capacity we have rather than capacity we do not)
- Rollback becomes `docker compose pull app:sha-<old> && docker compose up -d` — seconds instead of a VPS rebuild
- Image history lives in GHCR — a free audit trail, inspectable from any `docker pull` client
- VPS-loss recovery is trivial: a fresh host pulls the desired SHA from GHCR and comes up
- Build and runtime concerns are cleanly separated — the VPS is purely a runtime host

### Negative

- GHCR becomes a runtime dependency for *deploying* (not for serving — the already-deployed image keeps running if GHCR is unreachable). Mitigated by the observation that GitHub Actions is already our critical path: if GHCR is down, GitHub Actions is probably also down, and we cannot deploy anyway. No new single point of failure in practice.
- CI cold-build time adds ~1–2 minutes; warm builds (GHA cache hit) are ~10–15 seconds. Net system cost is lower than building on the VPS, but individual CI runs feel slightly slower.
- Every commit produces a new image even when the delta is small. GHA layer caching absorbs the redundant work; GHCR retention handles the stale tags.
- Image retention becomes a new operational concern — stale SHA tags accumulate unless the built-in policy is configured.
- The CI runner's Docker version is not pinned under ADR-0009's regime. This is a controlled drift: OCI images are portable across reasonably-versioned Docker daemons, and only the manifest format needs to match. Acceptable for now; the upcoming security audit will determine whether this gap needs explicit mitigation.

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md) — this ADR refines the CI/CD topology that ADR-0003 left open-ended
- [ADR-0008: VPN-first network access](0008-vpn-first-network-access.md) — defines why a GitHub runner cannot reach the app directly
- [ADR-0009: Pin Docker Engine and Compose versions across environments](0009-pin-docker-versions-across-environments.md) — defines the pin regime; this ADR introduces a controlled deviation for the CI builder
- #76 — implementation issue
- PR #71 — real `/api/health` probe (enabler: the deploy smoke test now distinguishes healthy from degraded stacks)
- PR #74 — path-filtered Docker CI validation (sibling work; the `build-and-push` job will sit alongside the validation `docker` job)
