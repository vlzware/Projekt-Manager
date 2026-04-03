# Plan

## Iteration 0.A - Discovery
- project definition
- preliminary discussions with the target company[^1]
- realization of scope and setting limits
- consideration of approaching the project as a general solution for a wider audience

**Artifacts**
- Kickoff document

## Iteration 0.B - Clarification
- meetings with stakeholders, clarification of details and ambiguities[^1]
- meeting with owner, clarification of roles and rights[^1]
- clarification of data, fields, types and their relations[^1]

**Artifacts**
- definition of a "walking skeleton"
- detailed specification for the implementation of a "walking skeleton"
- interactive prototypes (code-based; replaces traditional wireframes — iterating in code is faster for well-established UI patterns like calendar and Kanban)

## Iteration 0.C - Pre-Work Setup (recurring)
Environment setup is not a one-time phase — it recurs before each iteration that introduces new technology (e.g., backend, hosting, new integrations). The initial pass covers the walking skeleton's front-end stack. Subsequent passes extend the environment as the project grows.

- separation of the work into modules
- setting up an environment, coding style, and workflow

**Artifacts** (initial pass)
- Git repository initialized with branch protection rules.
- CI/CD pipeline configured (e.g., .github/workflows/ci.yml).
- Linter and Formatter configured (e.g., eslint.config.js or .prettierrc).
- Test framework installed and dummy test passing.
- Quality gates defined (e.g., coverage).
- A Kanban board set up.

## Iteration 1 - implementation of a "walking skeleton"
...
**Artifacts**
- a "walking skeleton"
- presentation[^1]

## Iteration 2, 3, ...
presentation[^1] -> scope for the next iteration -> specification -> tests -> implementation -> presentation[^1] ...
until all goals, defined in the Definition of Done, are achieved (see [Done when](kickoff.md#done-when))

## Time allocation
We plan to use different LLMs in a custom workflow for most of the implementation work. Thus, we expect that the most time-consuming part of the project will be the clarification of goals, definition of the current scope, integration and quality control. We plan to start with a 3-day slot for an iteration cycle, which may be adjusted as needed.


[^1]: For this Open-Source repository, no real company data will be used and thus reasonable assumptions are to be made. See [Company specifics](kickoff.md#company-specifics)