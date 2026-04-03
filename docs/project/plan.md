# Plan

> Iterations 0 and 1 completed faster than the 3-day estimate. The cycle stays at 3 days for now — earlier iterations were spec-heavy with less implementation.

## Iteration 0.A - Discovery ✅

- [x] project definition
- [x] preliminary discussions with the target company[^1]
- [x] realization of scope and setting limits
- [x] consideration of approaching the project as a general solution for a wider audience

**Artifacts**
- [x] Kickoff document

## Iteration 0.B - Clarification ✅

- [x] meetings with stakeholders, clarification of details and ambiguities[^1]
- [x] meeting with owner, clarification of roles and rights[^1]
- [x] clarification of data, fields, types and their relations[^1]

**Artifacts**
- [x] definition of a "walking skeleton"
- [x] detailed specification for the implementation of a "walking skeleton"
- [x] interactive prototypes (code-based; replaces traditional wireframes — iterating in code is faster for well-established UI patterns like calendar and Kanban)

## Iteration 0.C - Pre-Work Setup ✅

- [x] separation of the work into modules
- [x] setting up an environment, coding style, and workflow

**Artifacts**
- [x] Git repository initialized with branch protection rules.
- [x] A Kanban board set up.
- [x] CONTRIBUTING.md with conventions, code style, branching strategy

> **Note:** Stack-dependent tooling (linter, test framework, CI, quality gates) could not be set up until the tech stack was decided in iteration 1. These items are tracked as iteration 1 issues (#19–#21).

Environment setup recurs whenever an iteration introduces new technology (e.g., backend, hosting). This is documented as a convention in [CONTRIBUTING.md](../../CONTRIBUTING.md#iterations-and-milestones), not as a repeated iteration.

## Iteration 1 - Walking Skeleton ✅ (in progress)

- [x] parallel prototyping of 5 tech stacks (React+FullCalendar+shadcn, React+Custom, Svelte 5, Vue 3, PHP)
- [x] empirical evaluation: page weight, LOC, build time, configurability audit
- [x] tech stack decision formalized as ADR-0002
- [x] presentation to pilot company[^1] — positive validation of information architecture
- [ ] chosen stack (React, Prototype B) promoted to main codebase
- [ ] remaining 0.C items completed: linter, formatter, test framework, quality gates, CI
- [ ] full spec implementation on chosen stack with all tests passing
- [ ] retrospection → issues for the backlog

**Artifacts**
- [x] a "walking skeleton" (prototype stage — 5 implementations)
- [x] presentation[^1]
- [ ] production-quality walking skeleton on chosen stack

## Iteration 2 - Deployment and Data

Goal: give the pilot company a URL they can visit and interact with. Move from mock data to a real data source. Set up CI so every push is validated.

- [ ] deploy the walking skeleton to a hosted environment (see [hosting research](../iterations/1/hosting.md))
- [ ] replace mock data with a persistent data source (database or file-based storage)
- [ ] API layer between frontend and data (even if minimal — the spec requires all mutations go through a state layer that can be swapped to a backend)
- [ ] CI pipeline: lint, type-check, test on every push
- [ ] basic access protection — persistent data (even mock) on a public URL needs at minimum a gate; shared password or token is sufficient; proper multi-user auth deferred to when roles are needed
- [ ] CD pipeline: auto-deploy to hosting on merge to main

**Artifacts**
- a live, accessible walking skeleton with persistent data
- CI/CD pipeline
- presentation[^1]

**Open questions for specification:**
- Database choice: SQLite (simplest, file-based), PostgreSQL (scales later), or hosted (Supabase, PlanetScale)?
- API style: REST, tRPC, or server actions?
- How much real data? Full mock dataset loaded into DB, or actual project data from the pilot company?

## Iteration 3, 4, ...

presentation[^1] -> scope for the next iteration -> specification -> tests -> implementation -> presentation[^1] ...
until all goals, defined in the Definition of Done, are achieved (see [Done when](kickoff.md#done-when))

## Specification process

Each iteration's spec follows a multi-agent, adversarial approach:

1. **Input documents**: kickoff, plan, current spec, and any relevant ADRs are provided to multiple independent agents (different LLMs, different interfaces).
2. **Reasonable assumptions**: agents propose specs based on domain assumptions (see [Company specifics](kickoff.md#company-specifics)), not real company data.
3. **Triage**: proposals are evaluated against criteria by isolated reviewers, then synthesized.
4. **Scope**: specs describe **what** (behavior, acceptance criteria, data model), not **how** (architecture, implementation). The "how" lives in ADRs and design docs. Agents doing implementation derive the "how" from the "what."

## Time allocation

We plan to use different LLMs in a custom workflow for most of the implementation work. Thus, we expect that the most time-consuming part of the project will be the clarification of goals, definition of the current scope, integration and quality control. We plan to start with a 3-day slot for an iteration cycle, which may be adjusted as needed.


[^1]: For this Open-Source repository, no real company data will be used and thus reasonable assumptions are to be made. See [Company specifics](kickoff.md#company-specifics)
