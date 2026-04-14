# Test-Spec Traceability Matrix

Maps each acceptance criterion in [spec §15](../spec/verification.md#15-acceptance-criteria) to the tests that pin it. Test-ID columns reference the test specification in [spec §16](../spec/verification.md#16-test-specification): UT (§16.1 Unit), AT (§16.2 API integration). The `E2E` column references `e2e/*.spec.ts` files (and §16.3 step numbers where helpful). Cardinality is N:M.

The `Tier` column classifies each AC: `[crit]` = critical (data integrity, auth, money, misleading state — verified by unit/integration tests), `[vis]` = visual/design (verified by E2E visual regression), `[infra]` = infrastructure/structural (verified by deployment procedures, CI gates, lint, or code review — not by tests against the running system). See [verification.md AC legend](../spec/verification.md#15-acceptance-criteria).

`N/A — reason` means the AC cannot be exercised by §16.1–§16.2 tests (deployment infrastructure, structural/lint constraints, meta-requirements). All `[infra]` ACs map to `N/A — <reason>` in the test columns by definition.

This document is maintained as part of the workflow's test-spec traceability review (see [CONTRIBUTING.md §Workflow](../../CONTRIBUTING.md#workflow) step 3). Every AC must map to at least one test; unmapped criteria block implementation.

| AC     | Tier    | §      | Short text                                   | UT           | AT                | E2E                                              | Notes                                |
| ------ | ------- | ------ | -------------------------------------------- | ------------ | ----------------- | ------------------------------------------------ | ------------------------------------ |
| AC-1   | [vis]   | §15.1  | Local stack startup                          |              |                   | startup.spec.ts                                  | Boot sanity                          |
| AC-2   | [vis]   | §15.1  | Kanban renders 9 columns                     |              | AT-8              | kanban-flows.spec.ts (render)                    |                                      |
| AC-3   | [vis]   | §15.1  | Calendar bars                                |              |                   | kanban-flows.spec.ts (calendar)                  |                                      |
| AC-4   | [vis]   | §15.1  | Card opens detail panel                      |              |                   | kanban-flows.spec.ts                             |                                      |
| AC-5   | [crit]  | §15.1  | Forward transition + dialog + persist        |              | AT-9              | kanban-flows.spec.ts (transitions, persistence)  |                                      |
| AC-6   | [crit]  | §15.1  | Backward transition + persist                |              | AT-9              | kanban-flows.spec.ts (transitions, persistence)  | AT-9 covers backward via §step-10    |
| AC-7   | [crit]  | §15.1  | Date change + persist + reflected            |              | AT-12, AT-13      | kanban-flows.spec.ts (date editing, persistence) | AT-13 pins inverse-range rejection   |
| AC-8   | [vis]   | §15.1  | Summary action + buffer counts               |              |                   | kanban-flows.spec.ts (summary filter)            |                                      |
| AC-9   | [vis]   | §15.1  | Summary indicator filters view               |              |                   | kanban-flows.spec.ts (summary filter)            |                                      |
| AC-10  | [vis]   | §15.1  | "X Projekte ohne Termin" counter             |              |                   | kanban-flows.spec.ts (calendar)                  |                                      |
| AC-11  | [vis]   | §15.2  | Action vs buffer styling                     |              |                   |                                                  |                                      |
| AC-12  | [vis]   | §15.2  | Consistent state colour                      |              |                   |                                                  |                                      |
| AC-13  | [vis]   | §15.2  | "seit X Tagen" indicator                     |              |                   |                                                  |                                      |
| AC-14  | [vis]   | §15.2  | Card field display                           |              |                   |                                                  |                                      |
| AC-15  | [vis]   | §15.2  | statusChangedAt + bold when aged             |              |                   |                                                  |                                      |
| AC-16  | [crit]  | §15.3  | Only +1 / -1 transitions                     | UT-4 to UT-7 | AT-10, AT-11      |                                                  | Domain + API enforce; no skip path   |
| AC-17  | [crit]  | §15.3  | Erledigt is terminal                         | UT-5, UT-7   | AT-10             |                                                  |                                      |
| AC-18  | [crit]  | §15.3  | Anfrage hides backward                       | UT-6         | AT-11             |                                                  |                                      |
| AC-19  | [vis]   | §15.3  | German dates + Monday week                   |              |                   |                                                  |                                      |
| AC-20  | [vis]   | §15.3  | Missing optional fields ok                   |              |                   |                                                  |                                      |
| AC-21  | [crit]  | §15.4  | Login screen only when unauth                |              | AT-6              | smoke.spec.ts AC-21                              |                                      |
| AC-22  | [crit]  | §15.4  | Valid creds → Kanban                         | UT-10, UT-11 | AT-1, AT-4        | smoke.spec.ts AC-22                              | UT-10/11 pin password hash compare   |
| AC-23  | [crit]  | §15.4  | Invalid creds → generic error                | UT-10        | AT-2              | failure-paths.spec.ts (header)                   |                                      |
| AC-24  | [vis]   | §15.4  | Display name in header                       |              |                   | smoke.spec.ts AC-24                              |                                      |
| AC-25  | [crit]  | §15.4  | Abmelden → login screen                      |              | Logout block      | smoke.spec.ts AC-25, kanban-flows.spec.ts AC-25  |                                      |
| AC-26  | [crit]  | §15.4  | Back button after logout safe                |              |                   | kanban-flows.spec.ts AC-26                       | Browser-only; E2E is correct level   |
| AC-27  | [crit]  | §15.4  | Session expiry mid-app → login               | UT-12        | AT-5              | failure-paths.spec.ts                            |                                      |
| AC-28  | [crit]  | §15.4  | Deactivated user rejected                    |              | AT-3, AT-7        |                                                  | AT-7 at auth.test.ts:374-429         |
| AC-29  | [crit]  | §15.5  | Multi-user concurrent visibility             |              |                   | auth.test.ts AC-29 block                         | API integration test, no AT ID       |
| AC-30  | [infra] | §15.6  | HTTPS + documented HTTP exception            |              |                   |                                                  | N/A — deployment infra               |
| AC-31  | [infra] | §15.6  | Pull-based deploy                            |              |                   |                                                  | N/A — deployment infra               |
| AC-32  | [infra] | §15.7  | Module structure                             |              |                   |                                                  | N/A — structural / lint              |
| AC-33  | [infra] | §15.7  | Mutations via API only                       |              |                   |                                                  | N/A — structural / lint              |
| AC-34  | [infra] | §15.7  | State config in `config/`                    |              |                   |                                                  | N/A — structural / lint              |
| AC-35  | [infra] | §15.7  | Dependency direction                         |              |                   |                                                  | N/A — structural / lint              |
| AC-36  | [infra] | §15.7  | Lint and format pass                         |              |                   |                                                  | N/A — CI gate, not a test            |
| AC-37  | [infra] | §15.7  | §16 tests pass                               |              |                   |                                                  | N/A — meta (the suite as a whole)    |
| AC-38  | [vis]   | §15.8  | Branding config drives header/footer         |              |                   |                                                  |                                      |
| AC-39  | [crit]  | §15.8  | Session duration via config                  | UT-12        | AT-1              | auth.test.ts AC-39 (cookie max-age)              | Implicit in every authed test        |
| AC-40  | [crit]  | §15.9  | Object storage upload/retrieve               |              | AT-16             |                                                  |                                      |
| AC-41  | [vis]   | §15.10 | Tier-3 collapse                              |              |                   |                                                  |                                      |
| AC-42  | [vis]   | §15.10 | Tier-2 collapse                              |              |                   |                                                  |                                      |
| AC-43  | [vis]   | §15.10 | Tier-1 collapse + action last                |              |                   |                                                  |                                      |
| AC-44  | [vis]   | §15.10 | Click collapsed column to expand             |              |                   |                                                  |                                      |
| AC-45  | [crit]  | §15.6  | HTTPS default + refusal + banner             | env.test.ts  |                   | insecure-banner.spec.ts                          | Multi-surface; banner pinned via E2E |
| AC-46  | [infra] | §15.6  | Failed deploy keeps old version              |              |                   |                                                  | N/A — deployment infra               |
| AC-47  | [infra] | §15.6  | Operator can rollback by SHA                 |              |                   |                                                  | N/A — deployment infra               |
| AC-48  | [infra] | §15.6  | Post-deploy smoke against /api/health        |              |                   |                                                  | N/A — deployment infra               |
| AC-49  | [infra] | §15.6  | VPN-only network access                      |              |                   |                                                  | N/A — deployment infra               |
| AC-50  | [infra] | §15.6  | Data persists across redeploy                |              |                   |                                                  | N/A — deployment infra               |
| AC-51  | [infra] | §15.6  | Deploy by SHA, not moving tag                |              |                   |                                                  | N/A — deployment infra               |
| AC-52  | [crit]  | §15.4  | Change own password                          |              | AT-14, AT-15      |                                                  |                                      |
| AC-53  | [crit]  | §15.3  | Failed mutation reverts UI                   | revert.test  |                   | failure-paths.spec.ts                            |                                      |
| AC-54  | [crit]  | §15.11 | Create customer → generated ID               |              | AT-23             |                                                  |                                      |
| AC-55  | [crit]  | §15.11 | Update customer PATCH semantics              |              | AT-24             |                                                  |                                      |
| AC-56  | [crit]  | §15.11 | List customers with search                   |              | AT-25             |                                                  |                                      |
| AC-57  | [crit]  | §15.11 | Get customer with project count              |              | AT-26             |                                                  |                                      |
| AC-58  | [crit]  | §15.11 | Project nests full customer object           |              | AT-17             |                                                  | Verified via project create response |
| AC-59  | [crit]  | §15.12 | Create project → first state                 |              | AT-17             | management-flows.spec.ts (step 19-20)            |                                      |
| AC-60  | [crit]  | §15.12 | Update project; status/number locked         |              | AT-20, AT-21      | management-flows.spec.ts (step 21)               |                                      |
| AC-61  | [crit]  | §15.12 | Soft-delete removes from views               |              | AT-22             |                                                  |                                      |
| AC-62  | [crit]  | §15.12 | Project number unique                        |              | AT-18             |                                                  |                                      |
| AC-63  | [crit]  | §15.13 | Owner creates user → can log in              |              | AT-28             | management-flows.spec.ts (step 22)               |                                      |
| AC-64  | [crit]  | §15.13 | Owner updates user; username locked          |              | AT-30             |                                                  |                                      |
| AC-65  | [crit]  | §15.13 | Deactivate user → sessions invalid           |              | AT-31             | management-flows.spec.ts (step 23)               |                                      |
| AC-66  | [crit]  | §15.13 | Reactivate user → can log in                 |              | AT-32             | management-flows.spec.ts (step 24)               |                                      |
| AC-67  | [crit]  | §15.13 | Reset password → sessions invalid            |              | AT-33             |                                                  |                                      |
| AC-68  | [crit]  | §15.13 | Self-deactivation rejected                   |              | AT-34             |                                                  |                                      |
| AC-69  | [crit]  | §15.13 | Only user:manage can manage users            |              | AT-38             |                                                  |                                      |
| AC-70  | [crit]  | §15.14 | Bulk customer import partial-success         |              | AT-35             | import-export-flows.spec.ts (step 25)            |                                      |
| AC-71  | [crit]  | §15.14 | Export projects (non-deleted, filter)        |              | AT-36             | import-export-flows.spec.ts (steps 26-27)        |                                      |
| AC-72  | [crit]  | §15.14 | Export customers (all, filter)               |              | AT-37             |                                                  |                                      |
| AC-73  | [crit]  | §15.14 | Export respects permissions                  |              | AT-36             |                                                  | Tested in export.test.ts auth checks |
| AC-74  | [vis]   | §15.15 | Navigation without reload                    |              |                   | management-flows.spec.ts (all steps)             |                                      |
| AC-75  | [vis]   | §15.15 | Unauthorized views hidden                    |              |                   |                                                  |                                      |
| AC-76  | [vis]   | §15.16 | Project table sortable/searchable            |              |                   | management-flows.spec.ts (step 21)               |                                      |
| AC-77  | [vis]   | §15.16 | Project creation → table + Kanban            |              |                   | management-flows.spec.ts (steps 19-20)           |                                      |
| AC-78  | [vis]   | §15.16 | Project edit (title, workers, etc.)          |              |                   | management-flows.spec.ts (step 21)               |                                      |
| AC-79  | [vis]   | §15.16 | Project delete soft-deletes                  |              | AT-22             |                                                  |                                      |
| AC-80  | [vis]   | §15.16 | Customer table with project counts           |              |                   |                                                  |                                      |
| AC-81  | [vis]   | §15.16 | Customer creation → dropdown ready           |              |                   | management-flows.spec.ts (steps 18-19)           |                                      |
| AC-82  | [vis]   | §15.16 | User view: user:read required                |              |                   | management-flows.spec.ts (step 22)               |                                      |
| AC-83  | [vis]   | §15.16 | User creation → can log in                   |              | AT-28             | management-flows.spec.ts (step 22)               |                                      |
| AC-84  | [vis]   | §15.16 | Deactivation → can't log in                  |              | AT-31             | management-flows.spec.ts (step 23)               |                                      |
| AC-85  | [vis]   | §15.16 | Customer → project without reload            |              |                   | management-flows.spec.ts (steps 18-19)           |                                      |
| AC-86  | [vis]   | §15.17 | Import preview table                         |              |                   | import-export-flows.spec.ts (step 25)            |                                      |
| AC-87  | [vis]   | §15.17 | Import result summary                        |              |                   | import-export-flows.spec.ts (step 25)            |                                      |
| AC-88  | [vis]   | §15.17 | Export projects → downloadable JSON          |              |                   | import-export-flows.spec.ts (steps 26-27)        |                                      |
| AC-89  | [vis]   | §15.17 | Export customers → downloadable JSON         |              |                   |                                                  |                                      |
| AC-90  | [vis]   | §15.17 | Import permissions respected                 |              | AT-35, AT-38      |                                                  | Tested in bulk + permission tests    |
| AC-91  | [crit]  | §15.11 | Delete customer (no projects)                |              | customers.test.ts |                                                  |                                      |
| AC-92  | [crit]  | §15.11 | Delete customer rejected (has projects)      |              | customers.test.ts |                                                  |                                      |
| AC-93  | [crit]  | §15.11 | Delete customer requires permission          |              | customers.test.ts |                                                  |                                      |
| AC-94  | [crit]  | §15.18 | Concurrent transition → conflict             |              | AT-49             |                                                  | data-integrity.test.ts               |
| AC-95  | [crit]  | §15.18 | Soft-deleted projects immutable              |              | AT-42,43,44       |                                                  | data-integrity.test.ts               |
| AC-96  | [crit]  | §15.18 | DB CHECK: valid status values                |              | AT-45             |                                                  | data-integrity.test.ts               |
| AC-97  | [crit]  | §15.18 | DB CHECK: end ≥ start                        |              | AT-46             |                                                  | data-integrity.test.ts               |
| AC-98  | [crit]  | §15.18 | Customer audit refs nullified on user delete |              | AT-47             |                                                  | data-integrity.test.ts               |
| AC-99  | [crit]  | §15.18 | Atomic project creation                      |              | AT-48             |                                                  | data-integrity.test.ts               |
| AC-100 | [crit]  | §15.19 | Extract: unauth rejected                     |              | AT-50             |                                                  | extract.test.ts                      |
| AC-101 | [crit]  | §15.19 | Extract: customer:write required             |              | AT-51             |                                                  | extract.test.ts                      |
| AC-102 | [crit]  | §15.19 | Extract: empty/oversize text rejected        |              | AT-52, AT-53      |                                                  | extract.test.ts                      |
| AC-103 | [crit]  | §15.19 | Extract: structured customer + project       |              | AT-54             |                                                  | extract.test.ts                      |
| AC-104 | [crit]  | §15.19 | Extract: upstream failure → server error     |              | AT-55             |                                                  | extract.test.ts                      |
| AC-105 | [vis]   | §15.19 | Extract: entry point permission-gated        |              |                   |                                                  |                                      |
| AC-106 | [vis]   | §15.19 | Extract: modal textarea + action             |              |                   |                                                  |                                      |
| AC-107 | [vis]   | §15.19 | Extract: review fields + existing match      |              |                   |                                                  |                                      |
| AC-108 | [infra] | §15.20 | Tokens in single source, no palette leaks    |              |                   |                                                  | N/A — structural / repo-scan         |
| AC-109 | [vis]   | §15.20 | `[data-theme]` overrides semantic layer      |              |                   | theming.spec.ts                                  |                                      |
| AC-110 | [vis]   | §15.20 | Dark mode surfaces + WCAG AA contrast        |              |                   | theming.spec.ts (dark)                           |                                      |
| AC-111 | [vis]   | §15.20 | Theme attribute applied before CSS parse     |              |                   | theming.spec.ts (no-FOUC)                        |                                      |
| AC-112 | [vis]   | §15.20 | `'system'` tracks OS scheme changes          |              |                   | theming.spec.ts (matchMedia)                     |                                      |
| AC-113 | [infra] | §15.20 | Accent from config, no hardcoded accent      |              |                   |                                                  | N/A — structural / repo-scan         |
| AC-114 | [vis]   | §15.20 | Changing accent propagates to all surfaces   |              |                   | theming.spec.ts (accent)                         |                                      |
| AC-115 | [crit]  | §15.21 | themePreference stored + default + CHECK     |              | AT-56, AT-57      |                                                  | Defense-in-depth CHECK               |
| AC-116 | [crit]  | §15.21 | Self-update round-trips through API          |              | AT-58             |                                                  |                                      |
| AC-117 | [crit]  | §15.21 | Self-update without session rejected         |              | AT-59             |                                                  |                                      |
| AC-118 | [crit]  | §15.21 | Self-update with invalid value rejected      |              | AT-60             |                                                  |                                      |
| AC-119 | [vis]   | §15.21 | User menu theme selector + persistence       |              |                   | theming.spec.ts (selector)                       |                                      |
| AC-120 | [vis]   | §15.21 | Server value wins on hydration               |              |                   | theming.spec.ts (hydration)                      |                                      |
