# Project Journal

## 2026-04-03
- Reality check feedback: orgaMAX has no data export; added "no extraction from current software" to kickoff Not Doing
- Hosting research reframed: production hosting out of scope; only dev/CI/demo hosting matters (issue #6 updated)
- Evaluated 5 spec proposals from different LLMs against 8 criteria using independent adversarial agents
- Synthesized final walking skeleton spec (docs/iterations/0/spec.md) from best elements of proposals 2 and 4
- Refined workflow to 9 states with proper Kanban semantics (action/buffer/active/done types)
- Corrected UX principle: board structure IS the visibility mechanism, not per-card decoration
- Two rounds of adversarial review (9+10 agents), all issues resolved — spec at 39/50
- Stack decision deferred to iteration 1: parallel prototyping → ADR
- Extensibility checklist added to spec with known-debt annotations
- Cleaned up superseded files (clarifications doc, spec proposals, hosting research)
- Closed iteration 0

## 2026-04-02
- Organized folder structure: docs/project/, docs/adr/, docs/iterations/preparation/
- Polished Kickoff.md and Plan.md (grammar/formatting), moved to docs/project/
- Added core principle to Kickoff: "making inaction visible"
- Added missing Anfrage state to workflow
- Updated Plan: code prototypes instead of wireframes, Iteration 0.C as recurring
- 8-agent team: walking skeleton spec preparation — established 7-state model with action/waiting alternation
- 6-agent team: framework evaluation — React chosen (Svelte eliminated on extensibility, Vue close second)
- Hosting research: Render (Frankfurt) + Hetzner Object Storage looks best (~EUR 18/mo zero-ops)
- Created README.md
- Open items tracked as GitHub Issues (#1-#9)
