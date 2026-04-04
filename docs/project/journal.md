# Project Journal

## 2026-04-04 (Iteration 2 — implementation)
- Full backend implemented: Fastify server, PostgreSQL via Drizzle ORM, session-based auth (login/logout/me/change-password), project routes (list/get/transition/dates)
- Object storage module (S3-compatible, tested against MinIO)
- Frontend auth: LoginForm, API-backed store mutations, header user menu with logout, session restoration, optimistic updates with error rollback
- Infrastructure: multi-stage Dockerfile, docker-compose (app + PostgreSQL + MinIO + Caddy), GitHub Actions CI/CD pipeline
- Code quality review (3 parallel reviewers), 9 findings fixed
- Docker smoke test passed: full stack boots, login works, Kanban renders 19 seed projects from PostgreSQL
- 136 tests passing (31 domain + 58 UI/component + 42 server API + 5 storage)
- 4 UX polish items created as backlog issues (#26–#29)
- ADR-0003 (deployment infrastructure) and ADR-0004 (backend stack) recorded

## 2026-04-03 (continued — Iteration 1)
- Parallel prototype implementation: 5 stacks built by independent agents in isolated worktrees
- Showed prototypes to pilot company — reaction: "excited" (validates information architecture)
- ADR-1 configurability audit: all prototypes ~30-40% compliant (state config centralized, UI strings/branding scattered — same gap everywhere, same fix)
- Created issue #17: responsive layout strategy for smaller screens
- Decision narrowed to: PHP vs TypeScript (framework choice within TS still open)

### Prototype Comparison (Iteration 1)

| | **A: React+FC+shadcn** | **B: React+Custom** | **C: Svelte 5** | **D: Vue 3+Pinia** | **E: PHP+Vanilla** |
|---|---|---|---|---|---|
| Page weight (Save As) | 257 kB | 240 kB | 247 kB | 237 kB | **95 kB** |
| Bundle (gzip JS+CSS) | 147 kB | 78.5 kB | 32.7 kB | 47 kB | N/A |
| Source LOC | 1,950 | 2,306 | 2,603 | 2,557 | 2,498 |
| Test LOC | 566 | 442 | 876 | 547 | 463 |
| Tests reported | 38 | 39 | 57 | 35+E2E | unverified |
| Agent build time | 11.7 min | 11.7 min | 15.2 min | 15.6 min | 14.7 min |
| Calendar | FullCalendar lib | Custom grid | Custom grid | Custom grid | Custom grid |
| State mgmt | Zustand | Zustand | Svelte runes | Pinia | PHP sessions |
| Styling | Tailwind 4 | CSS Modules | Scoped CSS | CSS Modules | Plain CSS |
| ADR-1 compliance | ~35% | ~35% | ~30% | ~35% | ~35% |

Design note: Vue prototype (D) had a nice implementation touch — full-height action columns with yellow background, favicon. This is implementation quality, not a framework advantage — any stack could do it.

**Decision**: TypeScript chosen over PHP. Reasoning: type safety end-to-end, single language, superior tooling/LSP, unified testing, better ecosystem for growth. PHP's advantages (page weight, hosting cost) neutralized by free-tier Node hosting and the app's small scale.

**Framework decision**: React 19 chosen. Reasoning: best LLM training data (measurably faster prototype generation), no version confusion (unlike Vue 2/3), largest ecosystem. Vue was close second on DX but the project optimizes for AI-assisted development, where React has a clear edge.

Prototype worktree branches preserved for reference:
- `worktree-agent-a9f3ffaf` — Proto A (React + FullCalendar + shadcn)
- `worktree-agent-a7814ee7` — Proto B (React + Custom Calendar)
- `worktree-agent-a4197a92` — Proto C (Svelte 5)
- `worktree-agent-a5e9f3b5` — Proto D (Vue 3 + Pinia)
- `worktree-agent-a7a59af4` — Proto E (PHP)

## 2026-04-03
- Reality check feedback: orgaMAX has no data export; added "no extraction from current software" to kickoff Not Doing
- Hosting research reframed: production hosting out of scope; only dev/CI/demo hosting matters (issue #6 updated)
- Evaluated 5 spec proposals from different LLMs against 8 criteria using independent adversarial agents
- Synthesized final walking skeleton spec (now docs/spec.md) from best elements of proposals 2 and 4
- Refined workflow to 9 states with proper Kanban semantics (action/buffer/active/done types)
- Corrected UX principle: board structure IS the visibility mechanism, not per-card decoration
- Two rounds of adversarial review (9+10 agents), all issues resolved — spec at 39/50
- Stack decision deferred to iteration 1: parallel prototyping → ADR
- Extensibility checklist added to spec with known-debt annotations
- Cleaned up superseded files (clarifications doc, spec proposals, hosting research)
- Closed iteration 0

## 2026-04-02
- Organized folder structure: docs/project/, docs/adr/ (iterations/ later flattened to docs/scope.md)
- Polished Kickoff.md and Plan.md (grammar/formatting), moved to docs/project/
- Added core principle to Kickoff: "making inaction visible"
- Added missing Anfrage state to workflow
- Updated Plan: code prototypes instead of wireframes, Iteration 0.C as recurring
- 8-agent team: walking skeleton spec preparation — established 7-state model with action/waiting alternation
- 6-agent team: framework evaluation — React chosen (Svelte eliminated on extensibility, Vue close second)
- Hosting research: Render (Frankfurt) + Hetzner Object Storage looks best (~EUR 18/mo zero-ops)
- Created README.md
- Open items tracked as GitHub Issues (#1-#9)
