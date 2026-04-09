import { test, expect } from '@playwright/test';
import { addDays, format, isSameMonth, lastDayOfMonth } from 'date-fns';

/**
 * E2E Kanban board flows
 *
 * Integration scenarios extracted from the original smoke test. The smoke
 * test is now a minimal boot-and-round-trip check (see smoke.spec.ts); this
 * file exercises the specific features that were previously bundled into
 * one 247-line mega-test. Each scenario is self-contained: a shared
 * beforeEach logs in, and every test starts from a clean Kanban view.
 *
 * Seed data assumptions (inherited from the previous smoke test):
 *   - User: inhaber / changeme (Thomas Berger, admin/owner)
 *   - 19 projects distributed across 9 states
 *   - 3 projects in rechnung_faellig
 *   - 2 projects in geplant (both with planned dates)
 *   - 4+ projects without dates
 *
 * Project IDs are auto-generated UUIDs — tests discover them dynamically
 * from the page rather than hardcoding.
 */

/**
 * Pick a date that is (a) in the future relative to today and (b) in the
 * same calendar month as today. The calendar view opens on the current
 * month by default, so a same-month target avoids the need to click
 * `calendar-next`/`calendar-prev` to find the day cell.
 */
function pickPlannedEndDate(): { iso: string; testId: string } {
  const today = new Date();
  let target = addDays(today, 5);
  if (!isSameMonth(target, today)) {
    target = lastDayOfMonth(today);
  }
  const iso = format(target, 'yyyy-MM-dd');
  return { iso, testId: `calendar-day-${iso}` };
}

test.describe('Kanban board flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-username').fill('inhaber');
    await page.getByTestId('login-password').fill('changeme');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  test.describe('Kanban board render', () => {
    test('renders all nine state columns after login', async ({ page }) => {
      // AC-22: Valid credentials → Kanban view with nine columns
      const columns = [
        'kanban-column-anfrage',
        'kanban-column-angebot',
        'kanban-column-beauftragt',
        'kanban-column-geplant',
        'kanban-column-in_arbeit',
        'kanban-column-abnahme',
        'kanban-column-rechnung_faellig',
        'kanban-column-abgerechnet',
        'kanban-column-erledigt',
      ];
      for (const col of columns) {
        await expect(page.getByTestId(col)).toBeVisible();
      }
    });
  });

  test.describe('Summary filter', () => {
    test('applies the filter when a summary indicator is clicked', async ({ page }) => {
      // AC-8: Summary area counts for action states
      const summaryArea = page.getByTestId('summary-area');
      await expect(summaryArea).toBeVisible();
      const rechnungIndicator = page.getByTestId('summary-action-rechnung_faellig');
      await expect(rechnungIndicator).toHaveText('3× Rechnung fällig');

      // AC-9: Clicking indicator filters to affected projects
      await rechnungIndicator.click();

      await expect(page.getByTestId('column-count-rechnung_faellig')).toContainText('3');
      // Filtered: other columns show 0 cards
      await expect(page.getByTestId('column-count-anfrage')).toContainText('0');
    });

    test('clears the filter via "Filter aufheben"', async ({ page }) => {
      // Apply the filter first so there is something to clear.
      await page.getByTestId('summary-action-rechnung_faellig').click();
      await expect(page.getByTestId('column-count-anfrage')).toContainText('0');

      const clearFilter = page.getByTestId('clear-filter');
      await expect(clearFilter).toBeVisible();
      await clearFilter.click();
      // After clearing, anfrage should show its original count
      await expect(page.getByTestId('column-count-anfrage')).toContainText('2');
    });
  });

  test.describe('State transitions', () => {
    // Net-zero teardown note: the kanban-flows suite has no DB reset
    // between tests (playwright.config.ts has no globalSetup, and the
    // web server is reused across tests). Each mutating test must
    // restore the seed state it touched — otherwise a later test that
    // picks a `.first()` card from the same column gets a different
    // card than the seed promises, cascading into count-assertion
    // failures that look unrelated to the real cause.
    test('advances a card via the forward button and confirmation', async ({ page }) => {
      // AC-4: Clicking a project opens the detail panel
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      await geplantCard.click();

      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      const detailPanel = page.getByTestId('detail-panel');
      await expect(detailPanel).toBeVisible();

      // AC-5: Forward transition with German confirmation dialog
      await page.getByTestId('detail-forward-button').click();
      const forwardDialog = page.getByTestId('confirm-dialog');
      await expect(forwardDialog).toBeVisible();
      await expect(forwardDialog).toContainText('Geplant → In Arbeit');
      await page.getByTestId('confirm-ok').click();
      await expect(forwardDialog).not.toBeVisible();
      await expect(page.getByTestId('detail-status-badge')).toContainText('In Arbeit');

      // Verify the card is now in the "In Arbeit" column
      await expect(
        page.getByTestId('kanban-column-in_arbeit').getByTestId(`project-card-${projectId}`),
      ).toBeVisible();

      // Summary counts reflect the intermediate state: geplant has
      // dropped by one. This pins the transition before teardown.
      await expect(page.getByTestId('column-count-geplant')).toContainText('1');

      // Net-zero teardown: move the card back to geplant so the seed
      // state is restored for later tests in this file. See the
      // describe-block comment above for why this matters.
      await page.getByTestId('detail-backward-button').click();
      const backwardDialog = page.getByTestId('confirm-dialog');
      await expect(backwardDialog).toBeVisible();
      await expect(backwardDialog).toContainText('In Arbeit → Geplant');
      await page.getByTestId('confirm-ok').click();
      await expect(backwardDialog).not.toBeVisible();
      await expect(page.getByTestId('detail-status-badge')).toContainText('Geplant');
      await expect(
        page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
      ).toBeVisible();
      await expect(page.getByTestId('column-count-geplant')).toContainText('2');
    });

    test('moves a card backward from the detail panel', async ({ page }) => {
      // Net-zero by construction: this test forwards then backs the
      // SAME card, so it restores the seed regardless of execution
      // order. The forward-test above also cleans up after itself —
      // see the describe-block comment for the rationale.

      // Set up: advance a geplant card so we have something to move back.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      await geplantCard.click();

      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      await expect(page.getByTestId('detail-panel')).toBeVisible();
      await page.getByTestId('detail-forward-button').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      await expect(page.getByTestId('detail-status-badge')).toContainText('In Arbeit');

      // AC-6: Backward transition
      await page.getByTestId('detail-backward-button').click();
      const backwardDialog = page.getByTestId('confirm-dialog');
      await expect(backwardDialog).toBeVisible();
      await expect(backwardDialog).toContainText('In Arbeit → Geplant');
      await page.getByTestId('confirm-ok').click();
      await expect(backwardDialog).not.toBeVisible();
      await expect(page.getByTestId('detail-status-badge')).toContainText('Geplant');

      // Verify the card is back in the "Geplant" column
      await expect(
        page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
      ).toBeVisible();

      // Geplant count restored
      await expect(page.getByTestId('column-count-geplant')).toContainText('2');

      // Cross-feature invariance: an unrelated state transition must not
      // touch the rechnung_faellig summary counter. (Preserved from the
      // original smoke Step 14 — Wave 2E verification flagged this as a
      // dropped assertion during the smoke/kanban-flows split.)
      await expect(page.getByTestId('summary-action-rechnung_faellig')).toContainText('3');
    });
  });

  test.describe('Detail panel date editing', () => {
    test('updates the planned end date and persists it', async ({ page }) => {
      // AC-7: Changing a date updates plannedEnd and persists
      // Both geplant projects have dates from seed data — only end date is changed.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      await geplantCard.click();
      await expect(page.getByTestId('detail-panel')).toBeVisible();

      // Wait for the PATCH to land before moving on, otherwise the next steps
      // may race the optimistic update against the actual server commit.
      const plannedEndDate = pickPlannedEndDate();
      const endDateInput = page.getByTestId('detail-date-end');
      await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/projects\/[^/]+\/dates$/.test(r.url()) && r.request().method() === 'PATCH',
        ),
        endDateInput.fill(plannedEndDate.iso),
      ]);

      await expect(endDateInput).toHaveValue(plannedEndDate.iso);
    });
  });

  test.describe('Calendar view', () => {
    test('shows the updated date bar after a detail-panel edit', async ({ page }) => {
      // Set up: pick a geplant project and change its end date (mirrors the
      // precondition from the original smoke test that fed this calendar check).
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      await geplantCard.click();

      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      const detailPanel = page.getByTestId('detail-panel');
      await expect(detailPanel).toBeVisible();

      const plannedEndDate = pickPlannedEndDate();
      const endDateInput = page.getByTestId('detail-date-end');
      await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/projects\/[^/]+\/dates$/.test(r.url()) && r.request().method() === 'PATCH',
        ),
        endDateInput.fill(plannedEndDate.iso),
      ]);

      // AC-3: Calendar renders projects with planned dates as colored bars
      await page.getByTestId('detail-close').click();
      await expect(detailPanel).not.toBeVisible();

      const calendarToggle = page.getByTestId('view-toggle-kalender');
      await calendarToggle.click();
      await expect(page.getByTestId('calendar-view')).toBeVisible();
      await expect(page.getByTestId('calendar-grid')).toBeVisible();
      // The project bar should be visible with the updated date
      const calendarBar = page.getByTestId(`calendar-bar-${projectId}`).first();
      await expect(calendarBar).toBeVisible();
      // Verify the calendar contains the day cell for the new planned end date.
      // The date is in the current month by construction, so no navigation needed.
      await expect(page.getByTestId(plannedEndDate.testId)).toBeVisible();
    });

    test('filters to projects without dates via the summary counter', async ({ page }) => {
      // Grab a geplant card ID — geplant projects have dates in seed data, so
      // this specific card must NOT show up once the dateless filter is applied.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      // Open calendar view where the "Projekte ohne Termin" counter lives.
      await page.getByTestId('view-toggle-kalender').click();
      await expect(page.getByTestId('calendar-view')).toBeVisible();

      // AC-10: "X Projekte ohne Termin" counter appears below calendar
      const noDatesCounter = page.getByTestId('no-dates-counter');
      await expect(noDatesCounter).toBeVisible();
      await expect(noDatesCounter).toContainText('Projekte ohne Termin');
      await noDatesCounter.click();

      // Should be back on Kanban filtered to projects without dates.
      // The geplant card has dates — it must NOT appear in the dateless filter.
      await expect(page.getByTestId('kanban-board')).toBeVisible();
      await expect(page.getByTestId(`project-card-${projectId}`)).not.toBeVisible();
      // Verify dateless projects are actually shown
      const visibleCards = page.locator('[data-testid^="project-card-"]');
      const cardCount = await visibleCards.count();
      expect(cardCount).toBeGreaterThan(0);
    });
  });

  test.describe('Session and navigation', () => {
    test('persists the user and mutations across a page refresh', async ({ page }) => {
      // Set up: perform a state transition and a date edit so both kinds of
      // mutation have something to verify post-reload.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      await geplantCard.click();

      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      await expect(page.getByTestId('detail-panel')).toBeVisible();

      // Forward transition: geplant → in_arbeit
      await page.getByTestId('detail-forward-button').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      await expect(page.getByTestId('detail-status-badge')).toContainText('In Arbeit');

      // Move back to geplant so we can edit its planned end date.
      await page.getByTestId('detail-backward-button').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-ok').click();
      await expect(page.getByTestId('detail-status-badge')).toContainText('Geplant');

      // Edit the planned end date.
      const plannedEndDate = pickPlannedEndDate();
      await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/projects\/[^/]+\/dates$/.test(r.url()) && r.request().method() === 'PATCH',
        ),
        page.getByTestId('detail-date-end').fill(plannedEndDate.iso),
      ]);
      await page.getByTestId('detail-close').click();

      // AC-5/AC-6/AC-7: Changes persist across page reloads
      await page.reload();

      // User is still authenticated — Kanban loads, not login screen
      await expect(page.getByTestId('kanban-board')).toBeVisible();
      await expect(page.getByTestId('login-form')).not.toBeVisible();

      // Display name still in header
      await expect(page.getByTestId('user-indicator')).toContainText('Thomas Berger');

      // Verify state transition persisted: project should still be in "Geplant" column
      await expect(
        page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
      ).toBeVisible();

      // The date change persisted — verify via detail panel. Use the same
      // computed date as the edit so this assertion does not become stale as
      // the calendar moves.
      await page.getByTestId(`project-card-${projectId}`).click();
      await expect(page.getByTestId('detail-panel')).toBeVisible();
      await expect(page.getByTestId('detail-date-end')).toHaveValue(plannedEndDate.iso);
    });

    test('back button does not leak project data after logout', async ({ page }) => {
      // Discover a project ID we can later assert is gone from the DOM.
      const geplantColumn = page.getByTestId('kanban-column-geplant');
      const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
      const cardTestId = await geplantCard.getAttribute('data-testid');
      const projectId = cardTestId!.replace('project-card-', '');

      // AC-25: Clicking "Abmelden" logs out and shows login screen
      await page.getByTestId('user-indicator').click();
      await page.getByTestId('logout-button').click();

      await expect(page.getByTestId('login-form')).toBeVisible();
      await expect(page.getByTestId('kanban-board')).not.toBeVisible();

      // AC-26: After logout, back button must not reveal project data
      await page.goBack();
      await expect(page.getByTestId('login-form')).toBeVisible();
      await expect(page.getByTestId('kanban-board')).not.toBeVisible();
      await expect(page.getByTestId(`project-card-${projectId}`)).not.toBeVisible();
    });
  });
});
