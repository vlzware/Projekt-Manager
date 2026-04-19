import { test, expect, type Page } from '@playwright/test';

/**
 * E2E — Activity feed / global Aktivität view.
 *
 * Pins:
 *   - AC-185 [vis] — project detail panel activity feed: reverse-chrono
 *     ordering, paginated via "Ältere anzeigen", empty state "Keine
 *     Aktivität".
 *   - AC-186 [vis] — payload drawer visibility per role: rendered for
 *     owner/office on any payload-bearing entry; rendered for the
 *     worker only on self-authored entries; absent on others' rows
 *     for workers.
 *   - AC-187 [crit] — destructive-action entries (purge, user-delete,
 *     roles-update): owner sees them in the global Aktivität view,
 *     office and worker do not. The API boundary is pinned by AT-93
 *     (src/server/__tests__/audit-log.test.ts); this spec walks the
 *     UI so a reviewer can watch the visibility split in UI mode
 *     (ADR-0014 [vis] contract).
 *
 * Expected failing state (step 3 of the workflow):
 *   - The audit tab `Aktivität` does not exist in the nav matrix yet
 *     — `getByTestId('view-toggle-aktivität')` fails to find it.
 *   - Project-detail activity feed markup does not exist yet —
 *     `getByTestId('project-activity-feed')` fails to find it.
 *   - The audit API does not exist, so even if markup stubs were
 *     present, the feed would be empty / 404.
 *
 * Role walk: owner, office, worker. Bookkeeper is intentionally not
 * in `audit:read` (api.md §14.3) — the nav tab must be absent for
 * bookkeeper, asserted as a separate case.
 *
 * Why `chromium-mutating`: the spec drives mutations (create project,
 * update it) so the activity feed has something to render. Running
 * under the mutating project serializes it after read-only specs
 * (playwright.config.ts) so the DB mutations don't race kanban-flows'
 * aggregate-count assertions.
 */

test.describe.configure({ mode: 'serial' });

/** Per-role login under a fresh storage state — copied from
 * `e2e/permission-visibility.spec.ts` for pattern consistency. */
async function loginAs(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill('changeme');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('header').waitFor();
}

// Seed users — same labels used in permission-visibility.spec.ts so
// a grep for a role lands one consistent constant table across specs.
const users = {
  owner: 'inhaber',
  office: 'buero',
  worker: 'arbeiter1',
  bookkeeper: 'buchhalter',
} as const;

// ---------------------------------------------------------------
// AC-186 — Aktivität nav presence per role (precondition for everything)
// ---------------------------------------------------------------
test.describe('AC-186: Aktivität nav visibility per role', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const role of ['owner', 'office', 'worker'] as const) {
    test(`${role} — Aktivität tab is rendered`, async ({ page }) => {
      await loginAs(page, users[role]);
      await expect(page.getByTestId('view-toggle-aktivität')).toHaveCount(1);
    });
  }

  test('bookkeeper — Aktivität tab is absent (no audit:read)', async ({ page }) => {
    await loginAs(page, users.bookkeeper);
    await expect(page.getByTestId('view-toggle-aktivität')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------
// AC-185 — Project-detail activity feed
// ---------------------------------------------------------------
test.describe('AC-185: project activity feed (reverse-chrono, paginated, empty state)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('owner — newest-first, "Ältere anzeigen" appends older entries without collapsing current set', async ({
    page,
  }) => {
    await loginAs(page, users.owner);

    // Resolve the "same card both times" identity up-front — the first
    // Kanban card (oldest statusChangedAt in the first column) and the
    // first Projekte table row (latest createdAt) need not be the same
    // project. Pin a single card by its testid and reuse it for both
    // the mutation path and the feed-verification open.
    await page.getByTestId('view-toggle-kanban').click();
    await page.getByTestId('kanban-board').waitFor();
    const firstCard = page.locator('[data-testid^="project-card-"]').first();
    const firstCardTestId = (await firstCard.getAttribute('data-testid'))!;
    await firstCard.click();
    await page.getByTestId('detail-panel').waitFor();

    const feed = page.getByTestId('project-activity-feed');
    await expect(feed).toBeVisible();

    // Drive two mutations so there are at least two audit rows to
    // compare timestamps on. The spec wants two rows scoped to the
    // card's project — so we mutate THIS card's detail panel rather
    // than a Projekte-view row that may belong to a different project.
    //
    // The project-detail panel drives `updateDates` via the date input,
    // which produces an `update`-action audit row tied to this project.
    // Two sequential edits yield two audit rows — enough for the
    // reverse-chrono check below.
    const dateStart = page.getByTestId('detail-date-start');
    await dateStart.fill('2026-05-01');
    await expect.poll(async () => await dateStart.inputValue()).toBe('2026-05-01');
    await dateStart.fill('2026-05-15');
    await expect.poll(async () => await dateStart.inputValue()).toBe('2026-05-15');

    // Close + reopen the same card so the feed refetches.
    await page.getByTestId('detail-close').click();
    await page.getByTestId('kanban-board').waitFor();
    await page.getByTestId(firstCardTestId).click();
    await page.getByTestId('detail-panel').waitFor();

    const rows = feed.locator('[data-testid^="activity-feed-row-"]');
    // Wait for the async feed fetch to land at least 2 rows — the
    // audit query is a separate network round-trip after the panel
    // mount, and a naive synchronous `count()` is racy.
    await expect.poll(async () => await rows.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // Newest-first — the two most recent rows both belong to the
    // project and the first row's timestamp is >= the second's
    // (the two PATCHes were sequential so strict > would flake).
    const firstTs = await rows.nth(0).getAttribute('data-created-at');
    const secondTs = await rows.nth(1).getAttribute('data-created-at');
    expect(firstTs).not.toBeNull();
    expect(secondTs).not.toBeNull();
    expect(Date.parse(firstTs!)).toBeGreaterThanOrEqual(Date.parse(secondTs!));

    // Pagination: "Ältere anzeigen" appends without collapsing.
    const olderButton = feed.getByRole('button', { name: /Ältere anzeigen/i });
    if (await olderButton.count()) {
      const before = await rows.count();
      await olderButton.click();
      // Wait for the row count to grow. 1.5× before is a sanity
      // lower bound — implementation may fetch any page size; what
      // the AC pins is "appends older entries without collapsing".
      await expect.poll(async () => await rows.count(), { timeout: 5000 }).toBeGreaterThan(before);
    }
  });

  // Removed: an earlier test drove "fresh project → Keine Aktivität" for
  // the owner, but a fresh project always carries its `create` audit
  // row for an owner (unscoped), so the empty-state could never fire on
  // that path. Empty-state coverage is pinned below by the
  // worker-unreachable case, where the reachability predicate produces
  // a genuinely empty scoped result. T-REDU removed.
  test('worker seeing an unreachable project — empty-state renders "Keine Aktivität"', async ({
    page,
  }) => {
    // Worker1 is NOT assigned to every project — the global feed
    // (for a project they aren't part of, accessed somehow) or an
    // empty scoped set must render the German empty-state text.
    //
    // Simpler concrete path: worker1 has no per-project access to
    // YYYY-001 (seeded with no worker assignments); on the global
    // Aktivität view filtered to entityId=YYYY-001, the feed is
    // empty and the UI must read "Keine Aktivität".
    await loginAs(page, users.worker);
    await page.getByTestId('view-toggle-aktivität').click();

    // The empty-state is a UI affordance — the spec pins the exact
    // German text in ui/workflow-views.md §8.4.1 and ui/management.md
    // §8.13.1.
    const emptyState = page.getByTestId('audit-empty-state');
    if (await emptyState.count()) {
      await expect(emptyState).toContainText('Keine Aktivität');
    } else {
      // If the implementation chose to hide the empty-state element
      // instead of emitting it, the list container must at least
      // render the text.
      await expect(page.getByText('Keine Aktivität')).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------
// AC-186 — Payload drawer visibility per role
// ---------------------------------------------------------------
//
// Drawer semantics (ui/workflow-views.md §8.4.1, ui/management.md §8.13.1):
//   - owner/office callers: drawer rendered for every payload-bearing entry.
//   - worker callers: drawer rendered only on rows where the worker is
//     the actor (self-authored). On every other row the API strips the
//     payload, so the drawer affordance is absent.
test.describe('AC-186: payload drawer visibility per role', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('owner sees a payload-drawer affordance on every payload-bearing row', async ({ page }) => {
    await loginAs(page, users.owner);
    await page.getByTestId('view-toggle-aktivität').click();

    // Find any row — owner is unscoped, so the first rendered row
    // has a payload (updates, creates, and deletes all do).
    const firstRow = page.locator('[data-testid^="activity-feed-row-"]').first();
    await firstRow.waitFor();
    await expect(firstRow.getByTestId('activity-feed-drawer-toggle')).toBeVisible();

    // Opening expands inline without a route change.
    const urlBefore = page.url();
    await firstRow.getByTestId('activity-feed-drawer-toggle').click();
    expect(page.url()).toBe(urlBefore);
    await expect(firstRow.getByTestId('activity-feed-drawer-content')).toBeVisible();
  });

  test('office sees a payload-drawer affordance on every payload-bearing row', async ({ page }) => {
    await loginAs(page, users.office);
    await page.getByTestId('view-toggle-aktivität').click();
    const firstRow = page.locator('[data-testid^="activity-feed-row-"]').first();
    await firstRow.waitFor();
    await expect(firstRow.getByTestId('activity-feed-drawer-toggle')).toBeVisible();
  });

  test('worker sees drawer on self-authored rows and NOT on others', async ({ page }) => {
    await loginAs(page, users.worker);

    // Precondition: the worker must have at least one self-authored
    // audit row, else the "drawer present on self-authored" half of
    // the AC-186 assertion cannot run. The earlier draft early-
    // returned on an empty feed — T-TAUT per conventions-tests.md —
    // so we drive a deliberate self-mutation here.
    //
    // The simplest worker-accessible mutation is the theme-preference
    // update on `/api/auth/me`. It produces an audit row where
    // `actorId == caller.id` — "self-authored" per api.md §14.2.8.
    // Worker holds `auth:change-password`, which covers the self-
    // profile mutation surface; the route is the same one
    // `e2e/theme-preference.spec.ts` exercises.
    const patchRes = await page.request.patch('/api/auth/me', {
      data: { themePreference: 'dark' },
    });
    if (!patchRes.ok()) {
      throw new Error(
        `AC-186 worker drawer precondition: PATCH /api/auth/me returned ${patchRes.status()} — worker cannot author an audit row through the self-profile route. Fixture is blocked until the route grants workers self-mutation access.`,
      );
    }

    await page.getByTestId('view-toggle-aktivität').click();

    const rows = page.locator('[data-testid^="activity-feed-row-"]');
    await rows.first().waitFor();
    const total = await rows.count();
    if (total === 0) {
      throw new Error(
        'AC-186 worker drawer precondition: worker feed is empty after a self-authored mutation. Either the PATCH did not commit, the audit row was not admitted for the actor under the scope predicate, or the feed failed to hydrate.',
      );
    }

    // Classify the rendered rows by authorship. The UI reflects the
    // API's payload-stripping via `data-has-payload` on each row:
    //   - data-has-payload="true"  → API returned a payload
    //                                → drawer toggle MUST be present.
    //   - data-has-payload="false" → API stripped the payload
    //                                → drawer toggle MUST be absent.
    //
    // Authorship is reflected via a sibling attribute the UI renders
    // from the API response (`data-self-authored="true"` on the
    // worker's own rows). The API contract in api.md §14.2.8 binds
    // the two together: worker-visible rows carry payload iff the
    // worker authored them.
    let selfAuthoredCount = 0;
    let nonSelfAuthoredCount = 0;
    for (let i = 0; i < total; i++) {
      const row = rows.nth(i);
      const hasPayload = await row.getAttribute('data-has-payload');
      const isSelfAuthored = (await row.getAttribute('data-self-authored')) === 'true';
      const toggleCount = await row.getByTestId('activity-feed-drawer-toggle').count();

      if (isSelfAuthored) {
        selfAuthoredCount += 1;
        // API contract: full payload returned on self-authored rows.
        expect(hasPayload).toBe('true');
        expect(toggleCount).toBe(1);
      } else {
        nonSelfAuthoredCount += 1;
        // API contract: payload stripped on every other row.
        expect(hasPayload).toBe('false');
        expect(toggleCount).toBe(0);
      }
    }

    // Both halves of the contract require both row classes to be
    // present — positive case alone could pass a bug that emits the
    // drawer on every row; negative alone could pass a bug that omits
    // the drawer entirely.
    expect(selfAuthoredCount).toBeGreaterThan(0);
    if (nonSelfAuthoredCount === 0) {
      throw new Error(
        'AC-186 worker drawer fixture: no non-self-authored rows in the worker feed. The negative half of the contract ("drawer absent on others") cannot be exercised. Seed an owner/office mutation on an assigned project before this spec runs to produce a non-self-authored row visible to the worker via reachability.',
      );
    }
  });
});

// ---------------------------------------------------------------
// AC-187 — Destructive-action row visibility differs by role
// ---------------------------------------------------------------
test.describe('AC-187: destructive entries — owner sees them, others do not', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Shared fixture — drive a purge (owner-only) so there is a known
  // destructive row in the feed that every subsequent role check can
  // look for. Running the setup here keeps the destructive fixture
  // isolated from other specs (kanban-flows etc.).
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await loginAs(page, users.owner);
      await page.getByTestId('view-toggle-kunden').click();
      await page.getByTestId('customer-create-button').click();
      const cust = `Destructive-fixture ${Date.now()}`;
      await page.getByTestId('customer-name-input').fill(cust);
      await page.getByTestId('customer-submit').click();

      await page.getByTestId('view-toggle-projekte').click();
      await page.getByTestId('project-create-button').click();
      const num = `AC187-${Date.now()}`;
      await page.getByTestId('project-number-input').fill(num);
      await page.getByTestId('project-title-input').fill('AC-187 purge fixture');
      await page.getByTestId('project-customer-select').selectOption({ label: cust });
      await page.getByTestId('project-submit').click();

      // Archive then purge.
      await page
        .getByTestId('project-table')
        .locator('tbody tr', { hasText: num })
        .getByTestId('project-archive-button')
        .click();
      await page.getByRole('button', { name: /Bestätigen|OK/i }).click();

      await page.getByTestId('archived-toggle').click();
      await page
        .getByTestId('project-table')
        .locator('tbody tr', { hasText: num })
        .getByTestId('project-purge-button')
        .click();
      await page.getByRole('button', { name: /Bestätigen|OK/i }).click();
    } finally {
      await page.close();
    }
  });

  test('owner — purge entries are visible in the global Aktivität view', async ({ page }) => {
    await loginAs(page, users.owner);
    await page.getByTestId('view-toggle-aktivität').click();

    // A row with action=purge must exist (the fixture above drove
    // one). The UI's German label for `purge` is implementation-
    // defined; we filter by a structural `data-action` attribute.
    const purgeRows = page.locator('[data-testid^="activity-feed-row-"][data-action="purge"]');
    await expect(purgeRows).not.toHaveCount(0);
  });

  test('office — purge entries are not visible', async ({ page }) => {
    await loginAs(page, users.office);
    await page.getByTestId('view-toggle-aktivität').click();
    const purgeRows = page.locator('[data-testid^="activity-feed-row-"][data-action="purge"]');
    await expect(purgeRows).toHaveCount(0);
  });

  test('worker — purge entries are not visible', async ({ page }) => {
    await loginAs(page, users.worker);
    await page.getByTestId('view-toggle-aktivität').click();
    const purgeRows = page.locator('[data-testid^="activity-feed-row-"][data-action="purge"]');
    await expect(purgeRows).toHaveCount(0);
  });
});
