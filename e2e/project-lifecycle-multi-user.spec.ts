import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * AC-277 — multi-user project-lifecycle invalidation over the SSE channel.
 *
 * Three actors on the same install per AC-277: an office session (the
 * always-open observer, parked on the Project Management list with the
 * Kanban surface reachable via tab toggle), a worker session, and an
 * owner-authenticated request. Each named lifecycle action is issued
 * from a session distinct from the office observer:
 *
 *   1. Worker advances a project (`+1` transition per AC-5) on a project
 *      the worker is assigned to (seed `-007`, geplant → in_arbeit).
 *   2. Owner archives a project (AC-61).
 *   3. Owner restores an archived project.
 *   4. Owner edits a project's planned dates (AC-7).
 *   5. Owner edits an assigned-worker set.
 *   6. Owner creates a new project (AC-59).
 *
 * After each mutation the office session's project-list surfaces
 * (Project Management view per ui/management.md §8.8, Kanban per
 * ui/workflow-views.md §8.2, Calendar per ui/workflow-views.md §8.3)
 * must reflect the change within 2 seconds with NO manual refresh —
 * driven by the `project_changed` event over `/api/events`
 * (api.md §14.2.13) and the project store's SSE refresh trigger that
 * re-issues api.md §14.2.2 (Projects).
 *
 * This is the value test the realtime channel exists to deliver for
 * project lifecycle — the always-open-observer gap that mount +
 * `visibilitychange` + post-mutation refresh alone leave open
 * (ADR-0025), parity with AC-273 for storage usage.
 *
 * Topology (mirrors `storage-usage-multi-user.spec.ts`):
 *   - Two long-lived browser contexts: office (observer), worker.
 *   - Per-test-arm one-shot owner request context for the five owner
 *     mutations — the AC names "owner …", and a request context is the
 *     cheapest way to issue an authenticated mutation from a session
 *     distinct from the office tab. The OFFICE browser session does NOT
 *     initiate any mutation; it must observe the resulting SSE frame.
 *
 * The 2-second propagation poll is the contractual gate: a polling
 * assertion fails fast on success and surfaces a clean error on timeout,
 * so a regression to a no-op SSE channel surfaces here as a 2 s timeout
 * failure rather than a silent slow path.
 *
 * Runs under `chromium-mutating` (project rows mutate the shared DB).
 * The `MUTATING_TESTS` regex in `playwright.config.ts` is updated to
 * match this filename.
 */

/**
 * AC-277 budget — every project-list surface mirrors the same project
 * store, so the same window applies to whichever surface the assertion
 * picks.
 */
const SSE_PROPAGATION_TIMEOUT_MS = 2_000;

/**
 * Seeded geplant project the worker is assigned to (see
 * `src/server/seed/business.ts` ASSIGNMENT_SPECS — `-007`,
 * arbeiter1+arbeiter2). The kanban-flows precedent picks `.first()`
 * from the geplant column for the same reason: the worker can advance
 * it (project:transition holds for assigned workers per the permission
 * matrix), and the column is non-empty by seed.
 *
 * The worker-advance arm uses the seeded project via the worker UI;
 * the owner arms each pick their target by number suffix lookup so the
 * tests do not collide with each other on the same row.
 */
const WORKER_GEPLANT_SUFFIX = '007';

/**
 * Seeded customer name we attach the owner-create new project to.
 * `Familie Müller` is the first customer in CUSTOMER_SPECS and is
 * guaranteed to exist after auth.setup reseeds.
 */
const OWNER_CREATE_CUSTOMER_NAME = 'Familie Müller';

/**
 * Resolve a seeded project's id by its number suffix via the owner's
 * `/api/projects?search=...` endpoint. Faster + deterministic than
 * scanning the office DOM for a row testid (rows don't carry the
 * project id in the existing ProjectManagement.tsx).
 */
async function resolveProjectIdBySuffix(
  ownerRequest: APIRequestContext,
  suffix: string,
): Promise<{ id: string; number: string; title: string }> {
  // Year prefix is `now.getFullYear()` per `buildBusinessEnvelope` —
  // search by the suffix substring rather than reconstructing the prefix
  // (the seed runs against `new Date()` at setup time, not the test
  // process's clock).
  const resp = await ownerRequest.get(`/api/projects?search=${encodeURIComponent(`-${suffix}`)}`);
  expect(resp.ok(), `project search failed: ${resp.status()} ${await resp.text()}`).toBe(true);
  const body = (await resp.json()) as { projects: Array<{ id: string; number: string; title: string }> };
  const match = body.projects.find((p) => p.number.endsWith(`-${suffix}`));
  if (!match) {
    throw new Error(`seed project with suffix -${suffix} not found in /api/projects response`);
  }
  return match;
}

/**
 * Resolve the seeded customer's id by name. The owner-create arm needs
 * a real customerId to satisfy the create body's UUID format gate.
 */
async function resolveCustomerIdByName(
  ownerRequest: APIRequestContext,
  name: string,
): Promise<string> {
  const resp = await ownerRequest.get('/api/customers');
  expect(resp.ok(), `customer fetch failed: ${resp.status()} ${await resp.text()}`).toBe(true);
  const body = (await resp.json()) as { customers: Array<{ id: string; name: string }> };
  const match = body.customers.find((c) => c.name === name);
  if (!match) {
    throw new Error(`seed customer "${name}" not found in /api/customers response`);
  }
  return match.id;
}

/**
 * Resolve a worker user id by username (for the assigned-worker-edit
 * arm). The seeded workers are arbeiter1 / arbeiter2.
 */
async function resolveUserIdByUsername(
  ownerRequest: APIRequestContext,
  username: string,
): Promise<string> {
  const resp = await ownerRequest.get('/api/users');
  expect(resp.ok(), `user fetch failed: ${resp.status()} ${await resp.text()}`).toBe(true);
  const body = (await resp.json()) as { users: Array<{ id: string; username: string }> };
  const match = body.users.find((u) => u.username === username);
  if (!match) {
    throw new Error(`seed user "${username}" not found in /api/users response`);
  }
  return match.id;
}

/**
 * Park the office observer on the Project Management list. This view
 * renders one row per project with the status badge, planned-date
 * column, and customer name — every field the six lifecycle actions
 * mutate. The whole point of AC-277 is "without manual refresh" —
 * every assertion below is allowed to consume only the SSE-driven
 * invalidation; no `goto`, `reload`, or visibility-change after this
 * initial mount.
 */
async function parkOfficeOnProjectList(officePage: Page): Promise<void> {
  await officePage.goto('/projekte');
  await expect(officePage.getByTestId('project-table')).toBeVisible();
}

/**
 * Snapshot a seeded project's row signal — we capture the row count
 * via a regex match on project number, plus the row's text content,
 * so the assertion below can detect either a status change (badge text
 * flips) or a row appearance/disappearance (archive / restore /
 * create).
 *
 * Returned together so the propagation poll can assert on either signal
 * using a single read.
 */
interface RowReadout {
  /** number of rows whose accessible name matches the regex. */
  matchCount: number;
  /** combined visible text of all matching rows, normalised. */
  text: string;
}

async function readProjectRow(officePage: Page, numberRegex: RegExp): Promise<RowReadout> {
  const rows = officePage.getByRole('row', { name: numberRegex });
  const matchCount = await rows.count();
  if (matchCount === 0) {
    return { matchCount: 0, text: '' };
  }
  // .innerText() concatenates all matched rows' text so a status flip
  // shows up as a string diff; whitespace is collapsed because the row
  // template renders dates with thin spaces and CSS-derived gaps that
  // would otherwise produce noisy diffs.
  const parts: string[] = [];
  for (let i = 0; i < matchCount; i++) {
    parts.push((await rows.nth(i).innerText()).replace(/\s+/g, ' ').trim());
  }
  return { matchCount, text: parts.join(' || ') };
}

/**
 * Assert the office session's row readout changes within the AC-277
 * propagation budget. The poll's 2 s timeout is the gate; a passing
 * implementation resolves on the first project-store re-fetch tick
 * after the SSE frame lands.
 *
 * The previous (`before`) readout is snapshotted by the caller before
 * the mutation; we compare the live read to it and resolve when EITHER
 * the row count or the row text diverges. This single poll covers the
 * full cross-product of lifecycle actions:
 *   - transition / dates / assigned workers ⇒ text changes (status
 *     badge label, planned-date cell, assigned chips reflected via
 *     downstream rerenders).
 *   - archive ⇒ row disappears (count drops).
 *   - restore ⇒ row reappears (count rises) — the office observer keeps
 *     the show-archived toggle on so the row is observable post-archive
 *     and post-restore.
 *   - create ⇒ a new row matching the new number appears (count rises
 *     from 0 to 1).
 */
async function expectOfficeRowChanges(
  officePage: Page,
  numberRegex: RegExp,
  before: RowReadout,
  description: string,
): Promise<RowReadout> {
  await expect
    .poll(
      async () => {
        const now = await readProjectRow(officePage, numberRegex);
        return now.matchCount !== before.matchCount || now.text !== before.text;
      },
      {
        message: `office project-list did not reflect ${description} within the AC-277 propagation budget`,
        timeout: SSE_PROPAGATION_TIMEOUT_MS,
      },
    )
    .toBe(true);
  return readProjectRow(officePage, numberRegex);
}

test.describe('AC-277: project lifecycle propagates from worker / owner mutations to office observer over SSE', () => {
  let officeContext: BrowserContext;
  let workerContext: BrowserContext;
  let officePage: Page;
  let workerPage: Page;

  test.beforeAll(async ({ browser }) => {
    officeContext = await browser.newContext({ storageState: STORAGE_STATES.office });
    workerContext = await browser.newContext({ storageState: STORAGE_STATES.worker });
    officePage = await officeContext.newPage();
    workerPage = await workerContext.newPage();

    // The office session parks on the project list once for the suite.
    // Subsequent test arms reuse the same page — the SSE channel must
    // propagate state changes, not a goto / reload.
    await parkOfficeOnProjectList(officePage);
    // Surface archived rows from the start — the archive / restore arms
    // need them visible to observe the row's presence after each step.
    await officePage.getByTestId('project-show-archived-toggle').check();
  });

  test.afterAll(async () => {
    await officeContext.close();
    await workerContext.close();
  });

  // ------------------------------------------------------------------
  // 1. Worker advances a project (+1 transition per AC-5).
  //
  // The worker drives the kanban-card forward arrow per the precedent
  // in `kanban-flows.spec.ts`. AC-277 names this as the worker arm
  // because workers hold `project:transition` on assigned projects;
  // the seed assigns arbeiter1 to `-007` (geplant), so the +1 to
  // in_arbeit is the natural worker flow.
  //
  // Net-zero teardown: the arm rolls the project back to geplant via
  // the same kanban backward arrow so later arms (and later test runs
  // on the same DB without re-seed) see the seed column counts.
  // ------------------------------------------------------------------
  test('AC-277: office observer reflects worker advance within 2s', async () => {
    const numberRegex = new RegExp(`-${WORKER_GEPLANT_SUFFIX}\\b`);
    const before = await readProjectRow(officePage, numberRegex);

    // Worker drives the advance from their kanban surface. Mirrors
    // `kanban-flows.spec.ts` "advances a card via the forward button
    // and confirmation" test exactly.
    await workerPage.goto('/kanban');
    await expect(workerPage.getByTestId('kanban-board')).toBeVisible();

    const geplantColumn = workerPage.getByTestId('kanban-column-geplant');
    // Pin the target by suffix-resolved project id rather than `.first()` —
    // arbeiter1 is also assigned to `-008` (geplant), so a `.first()` lookup
    // is non-deterministic across kanban orderings.
    const target = await resolveProjectIdBySuffix(workerContext.request, WORKER_GEPLANT_SUFFIX);
    const projectId = target.id;
    const card = geplantColumn.getByTestId(`project-card-${projectId}`);
    await expect(card).toBeVisible();

    await card.getByTestId(`forward-button-${projectId}`).click();
    const dialog = workerPage.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await workerPage.getByTestId('confirm-ok').click();
    await expect(
      workerPage.getByTestId('kanban-column-in_arbeit').getByTestId(`project-card-${projectId}`),
    ).toBeVisible();

    // The OFFICE session is the AC-277 gate — its surface must reflect
    // the change without a manual refresh.
    await expectOfficeRowChanges(officePage, numberRegex, before, 'worker +1 transition');

    // Net-zero teardown: roll the card back to geplant so the seed
    // column counts later arms might depend on are restored. The office
    // observer will see this second mutation propagate too — that's
    // fine, the assertion already passed for the forward step.
    await workerPage
      .getByTestId('kanban-column-in_arbeit')
      .getByTestId(`project-card-${projectId}`)
      .getByTestId(`backward-button-${projectId}`)
      .click();
    await expect(workerPage.getByTestId('confirm-dialog')).toBeVisible();
    await workerPage.getByTestId('confirm-ok').click();
    await expect(
      workerPage.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
    ).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 2. Owner archives a project (AC-61).
  //
  // Issued from a one-shot owner request context — the AC-273 precedent
  // for cross-session-driven mutations. The OFFICE browser session does
  // not initiate the mutation; it must observe the resulting SSE frame.
  //
  // Target: `-008` (geplant, no worker assigned to advance it; safe to
  // archive without colliding with the worker arm above).
  // ------------------------------------------------------------------
  test('AC-277: office observer reflects owner archive within 2s', async ({ browser }) => {
    const SUFFIX = '008';
    const numberRegex = new RegExp(`-${SUFFIX}\\b`);
    const before = await readProjectRow(officePage, numberRegex);

    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const ownerRequest = ownerContext.request;
      const project = await resolveProjectIdBySuffix(ownerRequest, SUFFIX);
      const resp = await ownerRequest.delete(`/api/projects/${project.id}`);
      expect(resp.ok(), `archive failed: ${resp.status()} ${await resp.text()}`).toBe(true);
    } finally {
      await ownerContext.close();
    }

    await expectOfficeRowChanges(officePage, numberRegex, before, 'owner archive');
  });

  // ------------------------------------------------------------------
  // 3. Owner restores an archived project.
  //
  // Reuses the project archived in arm #2 — the office observer's
  // show-archived toggle is on, so the archived row is still visible
  // (with the Archiviert badge). After restore the row's text changes
  // (badge gone), which the row-readout poll catches.
  // ------------------------------------------------------------------
  test('AC-277: office observer reflects owner restore within 2s', async ({ browser }) => {
    const SUFFIX = '008';
    const numberRegex = new RegExp(`-${SUFFIX}\\b`);
    const before = await readProjectRow(officePage, numberRegex);

    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const ownerRequest = ownerContext.request;
      const project = await resolveProjectIdBySuffix(ownerRequest, SUFFIX);
      const resp = await ownerRequest.post(`/api/projects/${project.id}/restore`);
      expect(resp.ok(), `restore failed: ${resp.status()} ${await resp.text()}`).toBe(true);
    } finally {
      await ownerContext.close();
    }

    await expectOfficeRowChanges(officePage, numberRegex, before, 'owner restore');
  });

  // ------------------------------------------------------------------
  // 4. Owner edits a project's planned dates (AC-7).
  //
  // Target: `-009` (in_arbeit with seeded planned dates). Shifting the
  // planned end by one day produces a date-cell text diff the
  // row-readout catches.
  // ------------------------------------------------------------------
  test('AC-277: office observer reflects owner planned-dates edit within 2s', async ({ browser }) => {
    const SUFFIX = '009';
    const numberRegex = new RegExp(`-${SUFFIX}\\b`);
    const before = await readProjectRow(officePage, numberRegex);

    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const ownerRequest = ownerContext.request;
      const project = await resolveProjectIdBySuffix(ownerRequest, SUFFIX);
      // Fetch current dates so the new end is deterministically
      // different from the seed value (seed uses `daysFromNow(now, 2)`
      // for `-009`'s plannedEnd; bumping by 5 lands well outside any
      // mid-month rollover edge case).
      const detailResp = await ownerRequest.get(`/api/projects/${project.id}`);
      expect(detailResp.ok(), `project detail fetch failed: ${detailResp.status()}`).toBe(true);
      const detail = (await detailResp.json()) as { plannedEnd: string | null };
      const currentEnd = detail.plannedEnd ? new Date(detail.plannedEnd) : new Date();
      const newEnd = new Date(currentEnd);
      newEnd.setDate(newEnd.getDate() + 5);
      const newEndIso = newEnd.toISOString().slice(0, 10);

      const resp = await ownerRequest.patch(`/api/projects/${project.id}/dates`, {
        data: { plannedEnd: newEndIso },
      });
      expect(resp.ok(), `dates patch failed: ${resp.status()} ${await resp.text()}`).toBe(true);
    } finally {
      await ownerContext.close();
    }

    await expectOfficeRowChanges(officePage, numberRegex, before, 'owner planned-dates edit');
  });

  // ------------------------------------------------------------------
  // 5. Owner edits an assigned-worker set.
  //
  // Target: `-010` (in_arbeit, seeded with arbeiter2 only). Adding
  // arbeiter1 produces a `project_changed` event per AC-276 (the
  // assigned-worker-only branch). The Project Management list renders
  // the assigned-worker names inline, so the row-text diff catches the
  // new worker landing in the office surface — same shape as the
  // transition / dates / archive arms above.
  // ------------------------------------------------------------------
  test('AC-277: office observer reflects owner assigned-worker edit within 2s', async ({ browser }) => {
    const SUFFIX = '010';
    const numberRegex = new RegExp(`-${SUFFIX}\\b`);
    const before = await readProjectRow(officePage, numberRegex);

    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const ownerRequest = ownerContext.request;
      const project = await resolveProjectIdBySuffix(ownerRequest, SUFFIX);

      // Compose the new assigned-worker set: keep current + add
      // arbeiter1. Read the current set off the detail endpoint so the
      // seed-vs-test-mutation history can't drift.
      const detailResp = await ownerRequest.get(`/api/projects/${project.id}`);
      const detail = (await detailResp.json()) as { assignedWorkers: Array<{ userId: string }> };
      const arbeiter1Id = await resolveUserIdByUsername(ownerRequest, 'arbeiter1');
      const currentIds = new Set(detail.assignedWorkers.map((w) => w.userId));
      currentIds.add(arbeiter1Id);

      const resp = await ownerRequest.patch(`/api/projects/${project.id}`, {
        data: { assignedWorkerIds: Array.from(currentIds) },
      });
      expect(resp.ok(), `assigned-worker patch failed: ${resp.status()} ${await resp.text()}`).toBe(true);
    } finally {
      await ownerContext.close();
    }

    await expectOfficeRowChanges(officePage, numberRegex, before, 'owner assigned-worker edit');
  });

  // ------------------------------------------------------------------
  // 6. Owner creates a new project (AC-59).
  //
  // The new project's row must appear in the office list within 2 s.
  // The number is suffixed with the run timestamp so a re-run
  // against a non-reseeded DB does not hit the unique-number guard.
  // ------------------------------------------------------------------
  test('AC-277: office observer reflects owner project create within 2s', async ({ browser }) => {
    const newNumber = `E2E-AC277-${Date.now()}`;
    const numberRegex = new RegExp(newNumber);
    // The new number is unique to this test arm — count must be 0
    // before the mutation, 1 after.
    const before = await readProjectRow(officePage, numberRegex);
    expect(before.matchCount).toBe(0);

    const ownerContext = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const ownerRequest = ownerContext.request;
      const customerId = await resolveCustomerIdByName(ownerRequest, OWNER_CREATE_CUSTOMER_NAME);

      const resp = await ownerRequest.post('/api/projects', {
        data: {
          number: newNumber,
          title: `AC-277 lifecycle SSE test (${Date.now()})`,
          customerId,
        },
      });
      expect(resp.ok(), `create failed: ${resp.status()} ${await resp.text()}`).toBe(true);
    } finally {
      await ownerContext.close();
    }

    const after = await expectOfficeRowChanges(officePage, numberRegex, before, 'owner project create');
    // Directional invariant: a create produces exactly one new row;
    // a regression that fires the wrong invalidation (e.g. delete
    // event) would change the count in the wrong direction.
    expect(after.matchCount).toBe(1);
  });
});
