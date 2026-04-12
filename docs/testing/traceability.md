# Test-Spec Traceability Matrix

Maps each acceptance criterion in [spec §15](../spec/verification.md#15-acceptance-criteria) to the tests that pin it. Test-ID columns reference the test specification in [spec §16](../spec/verification.md#16-test-specification): UT (§16.1 Unit), CT (§16.2 Component), AT (§16.3 API integration). The `E2E` column references `e2e/*.spec.ts` files (and §16.4 step numbers where helpful). Cardinality is N:M.

`N/A — reason` means the AC cannot be exercised by §16.1–§16.3 tests (deployment infrastructure, structural/lint constraints, meta-requirements).

`†` marks component tests deferred to the implementation phase. These tests (CT-25 to CT-34) depend on component file paths, test IDs, and store shapes that do not yet exist. They will be written alongside the components. API integration tests and E2E tests cover the same ACs at their respective layers.

This document is maintained as part of the workflow's test-spec traceability review (see [CONTRIBUTING.md §Workflow](../../CONTRIBUTING.md#workflow) step 3). Every AC must map to at least one test; unmapped criteria block implementation.

| AC    | §      | Short text                            | UT           | CT           | AT           | E2E                                                         | Notes                                 |
| ----- | ------ | ------------------------------------- | ------------ | ------------ | ------------ | ----------------------------------------------------------- | ------------------------------------- |
| AC-1  | §15.1  | Local stack startup                   |              |              |              | startup.spec.ts                                             | Boot sanity                           |
| AC-2  | §15.1  | Kanban renders 9 columns              |              | CT-1, CT-2   | AT-8         | kanban-flows.spec.ts (render)                               | Implicit via CT-1/2 + AT-8            |
| AC-3  | §15.1  | Calendar bars                         |              | CT-11, CT-12 |              | kanban-flows.spec.ts (calendar)                             |                                       |
| AC-4  | §15.1  | Card opens detail panel               |              | CT-6         |              | kanban-flows.spec.ts                                        | Also pinned in DetailPanel.test.tsx   |
| AC-5  | §15.1  | Forward transition + dialog + persist |              | CT-7         | AT-9         | kanban-flows.spec.ts (transitions, persistence)             |                                       |
| AC-6  | §15.1  | Backward transition + persist         |              | CT-9         | AT-9         | kanban-flows.spec.ts (transitions, persistence)             | AT-9 covers backward via §step-10     |
| AC-7  | §15.1  | Date change + persist + reflected     |              | CT-17        | AT-12, AT-13 | kanban-flows.spec.ts (date editing, persistence)            | AT-13 pins inverse-range rejection    |
| AC-8  | §15.1  | Summary action + buffer counts        | UT-8, UT-9   | CT-13        |              | kanban-flows.spec.ts (summary filter)                       |                                       |
| AC-9  | §15.1  | Summary indicator filters view        |              | CT-14, CT-15 |              | kanban-flows.spec.ts (summary filter)                       |                                       |
| AC-10 | §15.1  | "X Projekte ohne Termin" counter      |              | CT-16        |              | kanban-flows.spec.ts (calendar)                             |                                       |
| AC-11 | §15.2  | Action vs buffer styling              |              |              |              | KanbanBoard.test.tsx AC-11                                  | Pinned in component test, no CT ID    |
| AC-12 | §15.2  | Consistent state colour               |              |              |              | KanbanBoard.test.tsx AC-12                                  | Pinned in component test, no CT ID    |
| AC-13 | §15.2  | "seit X Tagen" indicator              | UT-1, UT-2   | CT-5         |              |                                                             | UI side in KanbanBoard.test.tsx AC-13 |
| AC-14 | §15.2  | Card field display                    |              | CT-3, CT-4   |              |                                                             | Implicit via CT-3 + CT-4              |
| AC-15 | §15.2  | statusChangedAt + bold when aged      | UT-3         | CT-5         |              |                                                             | UI side in KanbanBoard.test.tsx AC-15 |
| AC-16 | §15.3  | Only +1 / -1 transitions              | UT-4 to UT-7 |              | AT-10, AT-11 |                                                             | Domain + API enforce; no skip path    |
| AC-17 | §15.3  | Erledigt is terminal                  | UT-5, UT-7   | CT-8, CT-10  | AT-10        |                                                             |                                       |
| AC-18 | §15.3  | Anfrage hides backward                | UT-6         | CT-10        | AT-11        |                                                             |                                       |
| AC-19 | §15.3  | German dates + Monday week            |              |              |              | KanbanBoard AC-19, Calendar AC-19                           | Supplementary dateFormat tests too    |
| AC-20 | §15.3  | Missing optional fields ok            |              |              |              | DetailPanel.test.tsx AC-20                                  | Pinned in component test, no CT ID    |
| AC-21 | §15.4  | Login screen only when unauth         |              | CT-18        | AT-6         | smoke.spec.ts AC-21                                         | CT-18 pins login form render          |
| AC-22 | §15.4  | Valid creds → Kanban                  | UT-10, UT-11 | CT-18, CT-19 | AT-1, AT-4   | smoke.spec.ts AC-22                                         | UT-10/11 pin password hash compare    |
| AC-23 | §15.4  | Invalid creds → generic error         | UT-10        | CT-20        | AT-2         | failure-paths.spec.ts (header)                              |                                       |
| AC-24 | §15.4  | Display name in header                |              | CT-21        |              | smoke.spec.ts AC-24                                         |                                       |
| AC-25 | §15.4  | Abmelden → login screen               |              | CT-22        |              | smoke.spec.ts AC-25, kanban-flows.spec.ts AC-25             |                                       |
| AC-26 | §15.4  | Back button after logout safe         |              |              |              | kanban-flows.spec.ts AC-26                                  |                                       |
| AC-27 | §15.4  | Session expiry mid-app → login        | UT-12        |              | AT-5         | failure-paths.spec.ts, auth.test.tsx AC-27                  |                                       |
| AC-28 | §15.4  | Deactivated user rejected             |              |              | AT-3, AT-7   |                                                             | AT-7 at auth.test.ts:374-429          |
| AC-29 | §15.5  | Multi-user concurrent visibility      |              |              |              | auth.test.ts AC-29 block                                    | API integration test, no AT ID        |
| AC-30 | §15.6  | Public URL + HTTPS                    |              |              |              |                                                             | N/A — deployment infra                |
| AC-31 | §15.6  | Pull-based deploy                     |              |              |              |                                                             | N/A — deployment infra                |
| AC-32 | §15.7  | Module structure                      |              |              |              |                                                             | N/A — structural / lint               |
| AC-33 | §15.7  | Mutations via API only                |              |              |              |                                                             | N/A — structural / lint               |
| AC-34 | §15.7  | State config in `config/`             |              |              |              |                                                             | N/A — structural / lint               |
| AC-35 | §15.7  | Dependency direction                  |              |              |              |                                                             | N/A — structural / lint               |
| AC-36 | §15.7  | Lint and format pass                  |              |              |              |                                                             | N/A — CI gate, not a test             |
| AC-37 | §15.7  | §16 tests pass                        |              |              |              |                                                             | N/A — meta (the suite as a whole)     |
| AC-38 | §15.8  | Branding config drives header/footer  |              |              |              | KanbanBoard.test.tsx AC-38                                  | Pinned in component test, no CT ID    |
| AC-39 | §15.8  | Session duration via config           | UT-12        |              | AT-1         | auth.test.ts AC-39 (cookie max-age)                         | Implicit in every authed test         |
| AC-40 | §15.9  | Object storage upload/retrieve        |              |              | AT-16        |                                                             |                                       |
| AC-41 | §15.10 | Tier-3 collapse                       |              |              |              | KanbanBoard.test.tsx AC-41                                  | Pinned in component test, no CT ID    |
| AC-42 | §15.10 | Tier-2 collapse                       |              |              |              | KanbanBoard.test.tsx AC-42                                  | Pinned in component test, no CT ID    |
| AC-43 | §15.10 | Tier-1 collapse + action last         |              |              |              | KanbanBoard.test.tsx AC-43                                  | Pinned in component test, no CT ID    |
| AC-44 | §15.10 | Click collapsed column to expand      |              |              |              | KanbanBoard.test.tsx AC-44                                  | Pinned in component test, no CT ID    |
| AC-45 | §15.6  | HTTPS default + refusal + banner      |              |              |              | env.test.ts (assertProductionSafe), insecure-banner.spec.ts | Multi-surface; banner pinned via E2E  |
| AC-46 | §15.6  | Failed deploy keeps old version       |              |              |              |                                                             | N/A — deployment infra                |
| AC-47 | §15.6  | Operator can rollback by SHA          |              |              |              |                                                             | N/A — deployment infra                |
| AC-48 | §15.6  | Post-deploy smoke against /api/health |              |              |              |                                                             | N/A — deployment infra                |
| AC-49 | §15.6  | VPN-only network access               |              |              |              |                                                             | N/A — deployment infra                |
| AC-50 | §15.6  | Data persists across redeploy         |              |              |              |                                                             | N/A — deployment infra                |
| AC-51 | §15.6  | Deploy by SHA, not moving tag         |              |              |              |                                                             | N/A — deployment infra                |
| AC-52 | §15.4  | Change own password                   |              |              | AT-14, AT-15 |                                                             |                                       |
| AC-53 | §15.3  | Failed mutation reverts UI            |              | CT-23        |              | failure-paths.spec.ts                                       |                                       |
| AC-54 | §15.11 | Create customer → generated ID        |              | CT-28†       | AT-23        |                                                             | CT-28 deferred to implementation      |
| AC-55 | §15.11 | Update customer PATCH semantics       |              |              | AT-24        |                                                             |                                       |
| AC-56 | §15.11 | List customers with search            |              | CT-27†       | AT-25        |                                                             | CT-27 deferred to implementation      |
| AC-57 | §15.11 | Get customer with project count       |              |              | AT-26        |                                                             |                                       |
| AC-58 | §15.11 | Project nests full customer object    |              |              | AT-17        |                                                             | Verified via project create response  |
| AC-59 | §15.12 | Create project → first state          |              | CT-26†       | AT-17        | management-flows.spec.ts (step 19-20)                       | CT-26 deferred to implementation      |
| AC-60 | §15.12 | Update project; status/number locked  |              |              | AT-20, AT-21 | management-flows.spec.ts (step 21)                          |                                       |
| AC-61 | §15.12 | Soft-delete removes from views        |              |              | AT-22        |                                                             |                                       |
| AC-62 | §15.12 | Project number unique                 |              |              | AT-18        |                                                             |                                       |
| AC-63 | §15.13 | Owner creates user → can log in       |              | CT-30†       | AT-28        | management-flows.spec.ts (step 22)                          | CT-30 deferred to implementation      |
| AC-64 | §15.13 | Owner updates user; username locked   |              |              | AT-30        |                                                             |                                       |
| AC-65 | §15.13 | Deactivate user → sessions invalid    |              |              | AT-31        | management-flows.spec.ts (step 23)                          |                                       |
| AC-66 | §15.13 | Reactivate user → can log in          |              |              | AT-32        | management-flows.spec.ts (step 24)                          |                                       |
| AC-67 | §15.13 | Reset password → sessions invalid     |              |              | AT-33        |                                                             |                                       |
| AC-68 | §15.13 | Self-deactivation rejected            |              |              | AT-34        |                                                             |                                       |
| AC-69 | §15.13 | Only user:manage can manage users     |              |              | AT-38        |                                                             |                                       |
| AC-70 | §15.14 | Bulk customer import partial-success  |              | CT-31†       | AT-35        | import-export-flows.spec.ts (step 25)                       | CT-31 deferred to implementation      |
| AC-71 | §15.14 | Export projects (non-deleted, filter) |              | CT-32†       | AT-36        | import-export-flows.spec.ts (steps 26-27)                   | CT-32 deferred to implementation      |
| AC-72 | §15.14 | Export customers (all, filter)        |              |              | AT-37        |                                                             |                                       |
| AC-73 | §15.14 | Export respects permissions           |              |              | AT-36        |                                                             | Tested in export.test.ts auth checks  |
| AC-74 | §15.15 | Navigation without reload             |              | CT-33†       |              | management-flows.spec.ts (all steps)                        | CT-33 deferred to implementation      |
| AC-75 | §15.15 | Unauthorized views hidden             |              | CT-33†       |              |                                                             | CT-33 deferred to implementation      |
| AC-76 | §15.16 | Project table sortable/searchable     |              | CT-25†       |              | management-flows.spec.ts (step 21)                          | CT-25 deferred to implementation      |
| AC-77 | §15.16 | Project creation → table + Kanban     |              | CT-26†       |              | management-flows.spec.ts (steps 19-20)                      | CT-26 deferred to implementation      |
| AC-78 | §15.16 | Project edit (title, workers, etc.)   |              |              |              | management-flows.spec.ts (step 21)                          |                                       |
| AC-79 | §15.16 | Project delete soft-deletes           |              |              | AT-22        |                                                             |                                       |
| AC-80 | §15.16 | Customer table with project counts    |              | CT-27†       |              |                                                             | CT-27 deferred to implementation      |
| AC-81 | §15.16 | Customer creation → dropdown ready    |              | CT-34†       |              | management-flows.spec.ts (steps 18-19)                      | CT-34 deferred to implementation      |
| AC-82 | §15.16 | User view: user:read required         |              | CT-29†       |              | management-flows.spec.ts (step 22)                          | CT-29 deferred to implementation      |
| AC-83 | §15.16 | User creation → can log in            |              |              | AT-28        | management-flows.spec.ts (step 22)                          |                                       |
| AC-84 | §15.16 | Deactivation → can't log in           |              |              | AT-31        | management-flows.spec.ts (step 23)                          |                                       |
| AC-85 | §15.16 | Customer → project without reload     |              | CT-34†       |              | management-flows.spec.ts (steps 18-19)                      | CT-34 deferred to implementation      |
| AC-86 | §15.17 | Import preview table                  |              | CT-31†       |              | import-export-flows.spec.ts (step 25)                       | CT-31 deferred to implementation      |
| AC-87 | §15.17 | Import result summary                 |              | CT-31†       |              | import-export-flows.spec.ts (step 25)                       | CT-31 deferred to implementation      |
| AC-88 | §15.17 | Export projects → downloadable JSON   |              | CT-32†       |              | import-export-flows.spec.ts (steps 26-27)                   | CT-32 deferred to implementation      |
| AC-89 | §15.17 | Export customers → downloadable JSON  |              | CT-32†       |              |                                                             | CT-32 deferred to implementation      |
| AC-90 | §15.17 | Import permissions respected          |              |              | AT-35, AT-38 |                                                             | Tested in bulk + permission tests     |
