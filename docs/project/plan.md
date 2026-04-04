# Plan

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

## Iteration 0.C - Pre-Work Setup

- [x] separation of the work into modules
- [x] setting up an environment, coding style, and workflow

**Artifacts**
- [x] Git repository initialized.
- [x] A GitHub Kanban board set up.
- [x] CONTRIBUTING.md with conventions, code style, branching strategy

> **Note:** Stack-dependent tooling (linter, test framework, CI, quality gates) could not be set up until the tech stack was decided in iteration 1. These items are tracked as iteration 1 issues (#19–#21).

Environment setup recurs whenever an iteration introduces new technology (e.g., backend, hosting).

## Iteration 1 - Walking Skeleton (in progress)

- [x] parallel prototyping of 5 tech stacks (React+FullCalendar+shadcn, React+Custom, Svelte 5, Vue 3, PHP)
- [x] empirical evaluation: page weight, LOC, build time, configurability audit
- [x] tech stack decision formalized as ADR-0002
- [x] presentation to pilot company[^1] — positive validation of information architecture
- [x] chosen implementation (React, Prototype B) promoted to the iteration branch, all tests passing
- [x] linter, formatter, test framework, quality gates
- [x] CI pipeline: lint, type-check, test on every push
- [ ] retrospection → issues for the backlog

**Artifacts**
- [x] a "walking skeleton" (prototype stage — 5 implementations)
- [x] presentation[^1]
- [ ] production-quality walking skeleton on chosen stack

## Iteration 2 - Deployment and Data

- [ ] API layer between frontend and data
- [ ] a module encapsulating all storage operations (S3 SDK)
- [ ] user authentication
- [ ] replace mock data with a persistent data source in a database
- [ ] deploy to a hosted environments - application and object storage (see [hosting research](../iterations/1/hosting.md))
- [ ] CD pipeline: auto-deploy to hosting on merge to main

**Artifacts**
- a live, accessible walking skeleton with persistent data
- CI/CD pipeline
- presentation[^1]

## Iteration 3, 4, ...

presentation[^1] -> scope for the next iteration -> specification -> tests -> implementation -> presentation[^1] ...
until all goals, defined in the Definition of Done, are achieved (see [Done when](kickoff.md#done-when))

## Time allocation

We plan to use different LLMs in a custom workflow for most of the implementation work. Thus, we expect that the most time-consuming part of the project will be the clarification of goals, definition of the current scope, integration and quality control. We plan to start with a 3-day slot for an iteration cycle, which may be adjusted as needed.


[^1]: For this Open-Source repository, no real company data will be used and thus reasonable assumptions are to be made. See [Company specifics](kickoff.md#company-specifics)
