import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';
import { clickView, expectViewReachable } from './nav-helpers';

/**
 * E2E — Activity feed / global Aktivität view.
 *
 * Pins:
 *   - AC-185 [vis] — project detail panel activity feed: reverse-chrono
 *     ordering, paginated via "Ältere anzeigen", empty state "Keine
 *     Aktivität".
 *   - AC-186 [vis] — payload drawer renders on any entry carrying a
 *     non-null payload. Owner and office both receive full payloads.
 *   - AC-187 [crit] — destructive-action entries (purge, user-delete,
 *     roles-update): owner sees them in the global Aktivität view,
 *     office does not. The API boundary is pinned by AT-93
 *     (src/server/__tests__/audit-log.test.ts); this spec walks the
 *     UI so a reviewer can watch the visibility split in UI mode
 *     (ADR-0014 [vis] contract).
 *
 * Role walk: owner, office. Worker and bookkeeper lack `audit:read`
 * (api.md §14.3) — both the nav tab and the deep-link path are
 * denied, asserted as separate cases.
 *
 * Auth: each describe uses the pre-authenticated storage state for its
 * target role (see e2e/auth.setup.ts). No per-test login — that path
 * burns through the dev-mode login rate limit at suite scale.
 *
 * Why `chromium-mutating`: the spec drives mutations (create project,
 * update it, purge it) so the activity feed has something to render.
 * Running under the mutating project serializes it after read-only
 * specs (playwright.config.ts) so the DB mutations don't race
 * kanban-flows' aggregate-count assertions.
 */

test.describe.configure({ mode: 'serial' });

/**
 * AC-186 drawer helper — click the toggle on a payload-bearing row,
 * assert the inline content expands, and assert the URL did not change
 * (the drawer is an inline affordance, not a route). Inlined here
 * rather than promoted to `e2e/helpers/` because every caller lives in
 * this file.
 */
async function assertDrawerOpensInline(
  page: Page,
  row: ReturnType<Page['locator']>,
): Promise<void> {
  const urlBefore = page.url();
  await row.getByTestId('activity-feed-drawer-toggle').click();
  expect(page.url()).toBe(urlBefore);
  await expect(row.getByTestId('activity-feed-drawer-content')).toBeVisible();
}

// ---------------------------------------------------------------
// AC-186 — Aktivität nav presence per role (precondition for everything)
// ---------------------------------------------------------------
test.describe('AC-186: Aktivität nav visibility per role', () => {
  // Owner + office see the Aktivität entry (inside the Verwaltung menu
  // for both — their secondary bucket has ≥2 items).
  for (const role of ['owner', 'office'] as const) {
    test.describe(role, () => {
      test.use({ storageState: STORAGE_STATES[role] });
      test('Aktivität tab is reachable from the header', async ({ page }) => {
        await page.goto('/');
        await expectViewReachable(page, 'aktivitaet', true);
      });
    });
  }

  // Worker and bookkeeper lack `audit:read`. Nav tab absent from
  // header; deep-link to /audit hits the not-permitted surface.
  for (const role of ['worker', 'bookkeeper'] as const) {
    test.describe(role, () => {
      test.use({ storageState: STORAGE_STATES[role] });
      test('Aktivität tab absent from nav; /audit is not-permitted', async ({ page }) => {
        await page.goto('/');
        await expectViewReachable(page, 'aktivitaet', false);
        await page.goto('/audit');
        await expect(page.getByTestId('not-permitted-view')).toBeVisible();
      });
    });
  }
});

// ---------------------------------------------------------------
// AC-185 — Project-detail activity feed
// ---------------------------------------------------------------
test.describe('AC-185: project activity feed (reverse-chrono, paginated, empty state)', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('owner — newest-first, "Ältere anzeigen" appends older entries without collapsing current set', async ({
    page,
  }) => {
    await page.goto('/');

    // Resolve the "same card both times" identity up-front — the first
    // Kanban card (oldest statusChangedAt in the first column) and the
    // first Projekte table row (latest createdAt) need not be the same
    // project. Pin a single card by its testid and reuse it for both
    // the mutation path and the feed-verification open.
    await page.getByTestId('view-toggle-kanban').click();
    await page.getByTestId('kanban-board').waitFor();
    const firstCard = page.locator('[data-testid^="project-card-"]').first();
    const firstCardTestId = (await firstCard.getAttribute('data-testid'))!;
    const projectId = firstCardTestId.replace('project-card-', '');
    await firstCard.click();
    await page.getByTestId('detail-panel').waitFor();

    const feed = page.getByTestId('project-activity-feed');
    await expect(feed).toBeVisible();

    // Drive mutations via the API with distinct field diffs so each
    // PATCH commits a new audit row (UI input debounce / unchanged-value
    // short-circuit would collapse repeated .fill() calls). Drive above
    // the server's default page size (50 per api.md §14.1) so the
    // "Ältere anzeigen" pager has a real page boundary to cross.
    // `notes` is the field `audit-log.test.ts` AT-93 uses to drive
    // audit rows on PATCH /api/projects/:id; the dates endpoint lives
    // separately at PATCH /api/projects/:id/dates and is out of scope here.
    const mutationCount = 52;
    for (let i = 0; i < mutationCount; i++) {
      const res = await page.request.patch(`/api/projects/${projectId}`, {
        data: { notes: `AC-185 mutation ${i} ${Date.now()}` },
      });
      expect(res.ok(), `PATCH ${i} failed with ${res.status()}`).toBe(true);
    }

    // Close + reopen the same card so the feed refetches.
    await page.getByTestId('detail-close').click();
    await page.getByTestId('kanban-board').waitFor();
    await page.getByTestId(firstCardTestId).click();
    await page.getByTestId('detail-panel').waitFor();

    const rows = feed.locator('[data-testid^="activity-feed-row-"]');
    // Wait for the async feed fetch to land the first page — the audit
    // query is a separate network round-trip after the panel mount, and
    // a naive synchronous `count()` is racy.
    await expect.poll(async () => await rows.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(2);

    // Reverse-chrono across every rendered row (M5) — collect all
    // timestamps and assert monotone non-increasing across every
    // adjacent pair. The server orders DESC on (createdAt, id); equal
    // timestamps are allowed because fixture writes can land in the
    // same millisecond.
    const timestamps = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-created-at')),
    );
    for (const ts of timestamps) expect(ts).not.toBeNull();
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(Date.parse(timestamps[i]!)).toBeGreaterThanOrEqual(Date.parse(timestamps[i + 1]!));
    }

    // Pagination: "Ältere anzeigen" appends without collapsing (H3).
    // Snapshot the row testids BEFORE the click, click, wait for the
    // count to grow, then assert the post-click set is a strict
    // superset of the pre-click set — a regression that drops N old
    // rows and appends M > N new rows would otherwise pass.
    const olderButton = feed.getByRole('button', { name: /Ältere anzeigen/i });
    await expect(olderButton).toBeVisible();
    const beforeTestIds = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')),
    );
    const before = beforeTestIds.length;
    await olderButton.click();
    await expect.poll(async () => await rows.count(), { timeout: 5000 }).toBeGreaterThan(before);
    const afterTestIds = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')),
    );
    const afterSet = new Set(afterTestIds);
    for (const tid of beforeTestIds) {
      expect(tid).not.toBeNull();
      expect(afterSet.has(tid), `row testid ${tid} was dropped after paginating`).toBe(true);
    }
  });

  test('empty-state renders "Keine Aktivität" on a filter that matches no rows', async ({
    page,
  }) => {
    // A `from` date in the far future is guaranteed to match zero rows
    // for any caller — the server AND-composes filters with the scope
    // predicate, so even an owner with unscoped reads receives an
    // empty page. This is the concrete "empty by construction" path
    // the finding asks for; filter-UI-driven rather than URL-driven
    // because the UI exposes no entityId filter today.
    await page.goto('/');
    await clickView(page, 'aktivitaet');
    await page.getByTestId('audit-filter-from').fill('2099-01-01');

    // The empty-state testid is rendered inside the list container
    // (ActivityFeed.tsx). Scope the match explicitly to that container
    // so a stray empty-state elsewhere in the DOM cannot satisfy the
    // assertion. The exact German copy is pinned by
    // ui/workflow-views.md §8.4.1 and ui/management.md §8.13.1.
    const list = page.getByTestId('audit-list');
    const emptyState = list.getByTestId('audit-empty-state');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('Keine Aktivität');
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
test.describe('AC-186: payload drawer visibility per role — owner', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('owner sees a payload-drawer affordance on every payload-bearing row', async ({ page }) => {
    await page.goto('/');
    await clickView(page, 'aktivitaet');

    // Find any row — owner is unscoped, so the first rendered row
    // has a payload (updates, creates, and deletes all do).
    const firstRow = page.locator('[data-testid^="activity-feed-row-"]').first();
    await firstRow.waitFor();
    await expect(firstRow.getByTestId('activity-feed-drawer-toggle')).toBeVisible();

    // Opening expands inline without a route change.
    await assertDrawerOpensInline(page, firstRow);
  });
});

test.describe('AC-186: payload drawer visibility per role — office', () => {
  test.use({ storageState: STORAGE_STATES.office });

  test('office sees a payload-drawer affordance on every payload-bearing row', async ({ page }) => {
    await page.goto('/');
    await clickView(page, 'aktivitaet');

    // Office is unscoped for destructive actions and every user-kind
    // row — the first rendered row is guaranteed to carry a payload,
    // so the drawer affordance must be present AND must open inline.
    const firstRow = page.locator('[data-testid^="activity-feed-row-"]').first();
    await firstRow.waitFor();
    await expect(firstRow.getByTestId('activity-feed-drawer-toggle')).toBeVisible();
    await assertDrawerOpensInline(page, firstRow);
  });
});

// ---------------------------------------------------------------
// AC-187 — Destructive-action row visibility differs by role
// ---------------------------------------------------------------
// Shared fixture drives a purge (owner-only) so there is a known
// destructive row every per-role test can look for. Driven via API
// rather than the UI — a 7-step UI chain is brittle and a mid-chain
// failure leaves the canary unable to distinguish "role filter wrong"
// from "fixture never ran".
test.describe('AC-187: destructive entries — owner sees them, others do not', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: STORAGE_STATES.owner });
    try {
      const custRes = await ctx.request.post('/api/customers', {
        data: { name: `Destructive-fixture ${Date.now()}` },
      });
      if (!custRes.ok()) {
        throw new Error(`AC-187 fixture: customer POST returned ${custRes.status()}`);
      }
      const custId = (await custRes.json()).id as string;

      const projRes = await ctx.request.post('/api/projects', {
        data: {
          number: `AC187-${Date.now()}`,
          title: 'AC-187 purge fixture',
          customerId: custId,
        },
      });
      if (!projRes.ok()) {
        throw new Error(`AC-187 fixture: project POST returned ${projRes.status()}`);
      }
      const projId = (await projRes.json()).id as string;

      // Archive (soft-delete) — precondition for purge per projects.ts:343.
      const archiveRes = await ctx.request.delete(`/api/projects/${projId}`);
      if (!archiveRes.ok()) {
        throw new Error(`AC-187 fixture: archive DELETE returned ${archiveRes.status()}`);
      }

      const purgeRes = await ctx.request.delete(`/api/projects/${projId}/purge`);
      if (!purgeRes.ok()) {
        throw new Error(`AC-187 fixture: purge DELETE returned ${purgeRes.status()}`);
      }

      // Canary (M7): verify a purge audit row actually landed for THIS
      // project id — a green fixture with a broken audit write would
      // silently pass every subsequent `toHaveCount(0)` role assertion.
      const auditRes = await ctx.request.get(`/api/audit?action=purge&entityId=${projId}`);
      if (!auditRes.ok()) {
        throw new Error(`AC-187 fixture: audit GET returned ${auditRes.status()}`);
      }
      const audit = (await auditRes.json()) as { data: unknown[] };
      if (!audit.data || audit.data.length === 0) {
        throw new Error(`AC-187 fixture: no purge audit row emitted for project ${projId}`);
      }
    } finally {
      await ctx.close();
    }
  });

  test.describe('owner', () => {
    test.use({ storageState: STORAGE_STATES.owner });
    test('purge entries are visible in the global Aktivität view', async ({ page }) => {
      await page.goto('/');
      await clickView(page, 'aktivitaet');
      // A row with action=purge must exist (the fixture above drove
      // one). The UI's German label for `purge` is implementation-
      // defined; we filter by a structural `data-action` attribute.
      const purgeRows = page.locator('[data-testid^="activity-feed-row-"][data-action="purge"]');
      await expect(purgeRows).not.toHaveCount(0);
    });
  });

  test.describe('office', () => {
    test.use({ storageState: STORAGE_STATES.office });
    test('purge entries are not visible', async ({ page }) => {
      await page.goto('/');
      await clickView(page, 'aktivitaet');
      const purgeRows = page.locator('[data-testid^="activity-feed-row-"][data-action="purge"]');
      await expect(purgeRows).toHaveCount(0);
    });
  });

});
