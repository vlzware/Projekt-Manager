# Projekt-Manager

## References
- **Repo**: vlzware/Projekt-Manager (private)
- **Project board**: https://github.com/users/vlzware/projects/2
- **Journal**: [docs/project/journal.md](docs/project/journal.md)
- **Decisions**: [docs/adr/](docs/adr/index.md)
- **Spec**: [docs/spec/](docs/spec/index.md)
- **Conventions**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Open items**: GitHub Issues, prioritized on the project board
- **Iteration scope**: GitHub Milestones

## Workflow
Follow [CONTRIBUTING.md § Workflow](CONTRIBUTING.md#workflow). Skipping or reordering steps must be flagged.

Detailed procedures for individual steps (agent orchestration, adversarial review, etc.) are defined in the corresponding skills.

## Principles

Security and quality defaults are the baseline, **not open questions.** When an established professional practice applies (HTTPS everywhere, input validation, auth on every mutation, CSRF protection, test isolation, ...), the default is to do it. The discussion — when there is one — is about *how* to implement it cleanly in the current topology, not *whether* to.

If the environment cannot meet a security or quality requirement, the correct behavior is to **refuse to serve, fail the deploy, or block the merge** — not to downgrade the requirement. When the implementation lags behind a safety criterion in the spec or an AC, fix the implementation. Do not rewrite the criterion to match the stub.

Concrete anchor: HTTPS must always terminate; the VPN does **not** substitute for TLS (defense in depth). See [ADR-0008](docs/adr/0008-vpn-first-network-access-tailscale.md) (amendment 2026-04-07) and [#47](https://github.com/vlzware/Projekt-Manager/issues/47). If a review proposes removing an HTTPS-enforcement AC because the Caddyfile isn't yet configured, the answer is to configure the Caddyfile — the AC was right.

## Undecided Specifics
Many details are deliberately left open until their iteration. When work hits something undefined:
1. Stop — do not assume.
2. Flag what is undefined and why it blocks.
3. When decided — suggest recording it as an ADR.
