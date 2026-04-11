# ADR-0012: Manual pull-based deploy over WireGuard

- **Status:** Accepted
- **Date:** 2026-04-10
- **Confidence:** High

## Context

ADR-0011 moved image builds from the VPS to GitHub Actions and GHCR. The build leg is now clean. The deploy leg — `.github/workflows/deploy.yml` SSHing into the VPS as the `deploy` user — was left unchanged, and this ADR is about replacing it.

Two forces make the push-based deploy path a liability rather than a convenience for the current stage of the project:

**1. Blast radius is disproportionate to the threat model.**

The `deploy` user is a member of the `docker` group, which is functionally equivalent to root: any member can `docker run -v /:/host --rm alpine chroot /host sh` and walk the host filesystem. This is an accepted Docker architecture quirk — not a project bug — but it means the SSH key held in `secrets.DEPLOY_KEY` is a root-equivalent credential. Anything that can read GitHub Actions secrets, inject a workflow step, or publish a malicious Action can execute arbitrary code as effective root on the only production host.

The realistic threats at pilot scale are data loss and unreliability, not a targeted actor with the capability to subvert the GitHub Actions supply chain. The push-based path optimizes for operator convenience (automatic deploys on green CI) at the cost of handing out a root-equivalent credential to an environment we do not audit for every commit.

**2. LLM-assisted solo workflow cannot reliably audit CD configuration.**

A concrete incident demonstrated the problem. The `workflow_run` trigger loads the workflow file from the default branch, not the branch whose CI run fired the event. Three separate `deploy.yml` changes landed on iteration branches and were **silently ignored** until the iteration merged. The caveat was documented; three independent changes were made anyway. The gotcha is not a knowledge failure the operator can fix by reading docs more carefully — it is a shape that the workflow surface makes easy to get wrong and hard to detect.

The pattern generalizes. CD configuration is security-critical code that runs with root privilege on the production host, and in a solo LLM-assisted workflow the reviewer's attention is saturated by the volume of diffs landing in any one session. "Accept and document" is not an acceptable posture for a foundation-level concern, and the only remaining move is to remove the foundation that needs auditing.

## Decision

We will delete the push-based GitHub Actions deploy path and replace it with a manual pull-based flow the operator runs on the VPS over WireGuard. Secrets will live encrypted at rest in a single age-wrapped file; plaintext will never touch disk. The artifact pipeline from ADR-0011 (CI → GHCR with SHA-tagged immutable images) is preserved unchanged — only the distribution-to-host leg is replaced.

### What's removed

- `.github/workflows/deploy.yml` — deleted outright
- GitHub repo secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEY`
- Interactive login path for the `deploy` user on the VPS (shell set to `/usr/sbin/nologin`, `~deploy/.ssh/authorized_keys` removed). The outbound `github_deploy` keypair and its `config` entry are kept — `scripts/deploy.sh` still needs them for `git fetch origin`.

The `deploy` user account itself is kept: it still owns `/opt/projekt-manager`, is still a member of the `docker` group, and is still the identity Docker Compose runs under. Only its ability to accept an SSH connection is removed.

### What stays

- `.github/workflows/ci.yml` — `check`, `changes`, `docker`, and `build-and-push` jobs all unchanged
- `ghcr.io/vlzware/projekt-manager` with `sha-<commit>` and `<branch-slug>` tags — ADR-0011's artifact pipeline is untouched
- Rollback story — any previously built SHA tag can be redeployed (now via `./deploy.sh <sha>` instead of re-running the Deploy workflow)
- SHA assertion after `git checkout` — the same guard the old script carried, preserved in `scripts/deploy.sh`
- Smoke test — the same `docker compose exec -T app node -e "fetch('/api/health')"` loop, preserved in `scripts/deploy.sh`

### What's new

- `scripts/deploy.sh` — committed to the repo, run on the VPS by the operator via `sudo -u deploy`. Takes an optional git ref (`origin/main` default, explicit SHA for rollback). Fetches, checks out, asserts SHA, decrypts secrets, pulls the GHCR image, `docker compose up -d`, polls `/api/health`.
- `/opt/projekt-manager/secrets.env.age` — age-encrypted (passphrase) environment file holding the three secrets that `docker-compose.yml` substitutes via `${VAR}`: `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `CLOUDFLARE_API_TOKEN`. Non-secret variables (`DOMAIN`, `MINIO_ROOT_USER`, `NODE_ENV`, etc.) live in the plain `.env` file, which docker compose reads automatically. `STORAGE_SECRET_KEY` is **not** in this file — the compose file derives it at runtime via `STORAGE_SECRET_KEY: ${MINIO_ROOT_PASSWORD}`. The plaintext is never written to disk on the VPS; `scripts/deploy.sh` sources the decrypted stream through process substitution (`source <(age -d …)`) so plaintext flows through an anonymous file descriptor the shell reads and discards.

### Operator flow

1. Log in to the VPS over WireGuard via the operator's own sudo account
2. `sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [ref]`
3. Enter age passphrase at the prompt
4. Script completes with `Deploy verified — healthy at <sha>` or fails loudly

## Alternatives considered

### Keep GHA→VPS with tighter scoping

Replace the broad SSH key with OIDC-issued short-lived credentials, or narrow the `deploy` user to a sudoers whitelist of exact `docker compose` subcommands. Rejected: the narrowing does reduce theoretical exposure, but it does not address the root concern — that CD configuration is itself security-critical code running with root privilege, and the LLM-assisted workflow cannot reliably audit it. The `workflow_run` gotcha would still apply to a narrowed script. The practical win over fully cutting the remote trust link is small for a solo pilot, and the operational overhead of maintaining an argument-matching sudoers whitelist is meaningful.

### Self-hosted GitHub Actions runner inside the WG tunnel

A dedicated runner host inside WG holds the deploy privilege and executes the workflow. Rejected for the same reasons ADR-0011 rejected it for builds: adds a second stateful host to operate and patch, and a self-hosted runner is itself a security-sensitive component (it executes arbitrary workflow code). Moves the trust problem, does not shrink it.

### Pull-based GitOps agent on the VPS

A long-lived agent (Flux, ArgoCD, or a lighter watchtower-style polling loop) runs on the VPS, watches GHCR or git, and reconciles on its own. This is the obvious target state at team scale. Rejected for this iteration because it adds a stateful component to operate and review, because the operator already watches every deploy (solo, email notifications on failure), and because the marginal gain over a manual `./deploy.sh` for a single operator is small. Kept as the explicit upgrade path below.

### Commit secrets to the repo (sops, sealed-secrets, SOPS+age)

Encrypt the environment file and commit it. The decrypt key still has to live on the VPS, so the trust root moves but does not shrink. Committing encrypted secrets makes sense when multiple operators or environments need a shared source of truth; with a single operator and a single environment the ergonomics cost (sops tooling, key rotation ceremony) is not repaid.

### Ansible Vault over SSH

Orchestrate deploys from the operator's laptop via Ansible with a vault for secrets. Rejected: introduces the same class of remote-trust-link the cutover is trying to remove, just shifted one layer. Also adds a tool whose own security posture the project does not audit.

## Consequences

### Positive

- **Remote trust link removed.** Compromising a GitHub Actions workflow, an Action publisher's package, or the repo secrets store no longer grants VPS access. The VPS is reachable only over WireGuard by an identity (the operator's personal account) that is independent of the GitHub Actions supply chain.
- **The `workflow_run` default-branch class of bug is designed out.** No CD workflow file, no `workflow_run` gotcha. The deploy script lives in-tree and is reviewed alongside every other code change — the same review surface as any other commit.
- **Secrets move off GitHub and off `docker-compose.yml`'s `environment:` at rest.** A single age passphrase unlocks them at invocation; the plaintext file never exists on the VPS disk. The project's secret surface shrinks to one encrypted file and one passphrase in the operator's password manager.
- **Rollback interface is the same as forward-deploy.** `./deploy.sh sha-<old>` vs `./deploy.sh origin/main`. No separate "how to roll back" procedure to remember under pressure.
- **Builds and GHCR are untouched.** ADR-0011's artifact pipeline stays in place; this ADR only replaces the distribution-to-host leg. The two concerns are cleanly separated.
- **The deploy configuration that can misconfigure the production host is one shell script, reviewed as code.** Not a multi-stage GitHub Actions DAG assembled from third-party Actions whose SHAs drift.

### Negative / residual risks

These are documented and accepted. Each has an upgrade path when the operational cost of the workaround exceeds the cost of the upgrade.

- **`deploy` is still in the `docker` group.** The cutover reduces the _exposure_ of this privilege (no remote key hands it out anymore) but does not eliminate the _posture_. Rootless Docker or Podman is the expected direction. Upgrade trigger: whenever the operational cost of migrating to rootless is justified by stack growth, or before the repo/GHCR package is made public.
- **GHCR PAT on the VPS.** `docker login` on the VPS uses a classic PAT scoped `read:packages`. Treat as a key: location, expiry, rotation cadence recorded in `docs/ops/manual-deploy.md`. A read-only package token is a small exposure compared to what was removed.
- **VPS reboot requires a manual re-deploy.** The operator has to log in over WG, enter the age passphrase, and re-run the script — the stack does not come back up on its own because the secrets are not on disk. Acceptable for pilot scale and a single operator. Upgrade trigger: when missed-reboot incidents accumulate, move to a VPS-local secrets manager (Docker secrets from a systemd-delivered unseal file, or a minimal KMS backend).
- **Passphrase loss = regenerate secrets from source systems.** The encrypted file is not irreplaceable data — the underlying secrets live in their systems of record (password manager, Cloudflare dashboard, Postgres / MinIO owner reset paths). Recovery procedure is documented in `docs/ops/manual-deploy.md`.
- **Compromised developer machine can publish a malicious image to GHCR.** Mitigated by the manual promotion step: an attacker-tagged image does not deploy itself, and the operator reviews the SHA they pass to `./deploy.sh` before invoking it. Not mitigated by this ADR alone; signing (Sigstore cosign) is the scale-up answer.
- **Solo-operator bus factor.** The passphrase lives with one person. Pilot scale makes this acceptable; a second operator means a second age recipient, which means either multi-recipient age encryption or a shared password-manager vault entry. Either is cheap to add when the second operator appears.

## Upgrade path

The cutover is a principled retreat to a smaller trust surface. The expected progression, in order:

1. **This ADR** — manual pull-based deploy, secrets encrypted at rest, no remote trust link
2. **Rootless Docker or Podman** — eliminates the `docker`-group-equals-root residual, enables the next step safely
3. **Pull-based GitOps agent** — reintroduces automation once the trust root is small enough that an always-on agent is not a net expansion of privilege
4. **Multi-recipient secrets and signed images** — once more than one operator exists or the GHCR package goes public

The artifact pipeline (CI → GHCR, ADR-0011) is compatible with every step above without modification. This is the scalability property the cutover preserves: future automation bolts onto the existing artifact pipeline, not a replacement for it.

## References

- [ADR-0003: Deployment infrastructure — VPS, Docker Compose, GitHub Actions](0003-deployment-infrastructure-vps-docker-compose-github-actions.md) — original topology; this ADR replaces its deploy leg
- [ADR-0008: VPN-first network access](0008-vpn-first-network-access.md) — defines the operator's access path
- [ADR-0009: Pin Docker versions across environments](0009-pin-docker-versions-across-environments.md) — still applies; the deploy script relies on deterministic compose behavior
- [ADR-0011: Build app images in CI, distribute via GHCR](0011-build-images-in-ci-distribute-via-ghcr.md) — unchanged by this ADR; this ADR only replaces the distribution-to-host leg
