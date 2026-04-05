import { test, expect } from '@playwright/test';

/**
 * E2E Smoke Test — Iteration 2
 *
 * Single scenario covering the full authenticated end-to-end path.
 * Maps to spec §16.4 steps 1–17.
 *
 * Seed data assumptions:
 *   - User: inhaber / changeme (Thomas Berger, admin/owner)
 *   - 19 projects distributed across 9 states
 *   - 3 projects in rechnung_faellig
 *   - 2 projects in geplant (both with planned dates)
 *   - 4+ projects without dates
 *
 * Project IDs are auto-generated UUIDs — the test discovers them
 * dynamically from the page rather than hardcoding.
 */
test('E2E Smoke Test: full authenticated interaction path', async ({ page }) => {
  // ── Step 1: App loads — login screen is displayed ──
  // AC-21: Unauthenticated users see only a login screen.
  await page.goto('/');
  const loginForm = page.getByTestId('login-form');
  await expect(loginForm).toBeVisible();
  await expect(page.getByTestId('login-username')).toBeVisible();
  await expect(page.getByTestId('login-password')).toBeVisible();
  await expect(page.getByTestId('login-submit')).toBeVisible();

  // No project data should be visible before login
  await expect(page.getByTestId('kanban-board')).not.toBeVisible();

  // ── Step 2: User enters credentials and logs in — Kanban view with 9 columns ──
  // AC-22: Valid credentials → Kanban view
  await page.getByTestId('login-username').fill('inhaber');
  await page.getByTestId('login-password').fill('changeme');
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('kanban-board')).toBeVisible();

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

  // ── Step 3: Header shows user's display name ──
  // AC-24: User indicator shows display name
  const userIndicator = page.getByTestId('user-indicator');
  await expect(userIndicator).toBeVisible();
  await expect(userIndicator).toContainText('Thomas Berger');

  // ── Step 4: Summary area shows "3× Rechnung fällig" ──
  // AC-8: Summary area counts for action states
  const summaryArea = page.getByTestId('summary-area');
  await expect(summaryArea).toBeVisible();
  const rechnungIndicator = page.getByTestId('summary-action-rechnung_faellig');
  await expect(rechnungIndicator).toHaveText('3× Rechnung fällig');

  // ── Step 5: User clicks a summary indicator — view filters to matching projects ──
  // AC-9: Clicking indicator filters to affected projects
  await rechnungIndicator.click();

  await expect(page.getByTestId('column-count-rechnung_faellig')).toContainText('3');
  // Filtered: other columns show 0 cards
  await expect(page.getByTestId('column-count-anfrage')).toContainText('0');

  // ── Step 6: User clicks "Filter aufheben" — full view restored ──
  const clearFilter = page.getByTestId('clear-filter');
  await expect(clearFilter).toBeVisible();
  await clearFilter.click();
  // After clearing, anfrage should show its original count
  await expect(page.getByTestId('column-count-anfrage')).toContainText('2');

  // ── Step 7: User clicks a card in Geplant — detail panel opens ──
  // AC-4: Clicking a project opens the detail panel
  // Discover the first project card in the Geplant column dynamically
  const geplantColumn = page.getByTestId('kanban-column-geplant');
  const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
  await geplantCard.click();

  // Extract the project ID from the card's data-testid for later assertions
  const cardTestId = await geplantCard.getAttribute('data-testid');
  const projectId = cardTestId!.replace('project-card-', '');

  const detailPanel = page.getByTestId('detail-panel');
  await expect(detailPanel).toBeVisible();

  // ── Step 8: User clicks "Nächster Schritt" — confirmation dialog appears ──
  // ── Step 9: User confirms — card moves to In Arbeit ──
  // AC-5: Forward transition with German confirmation dialog
  const [forwardDialog] = await Promise.all([
    page.waitForEvent('dialog'),
    page.getByTestId('detail-forward-button').click(),
  ]);
  expect(forwardDialog.message()).toContain('Geplant → In Arbeit');
  await forwardDialog.accept();
  await expect(page.getByTestId('detail-status-badge')).toContainText('In Arbeit');

  // Verify the card is now in the "In Arbeit" column
  await expect(
    page.getByTestId('kanban-column-in_arbeit').getByTestId(`project-card-${projectId}`),
  ).toBeVisible();

  // Step 14 (intermediate): summary counts reflect the transition
  await expect(page.getByTestId('column-count-geplant')).toContainText('1');

  // ── Step 10: User clicks "Vorheriger Schritt" — card moves back to Geplant ──
  // AC-6: Backward transition
  const [backwardDialog] = await Promise.all([
    page.waitForEvent('dialog'),
    page.getByTestId('detail-backward-button').click(),
  ]);
  expect(backwardDialog.message()).toContain('In Arbeit → Geplant');
  await backwardDialog.accept();
  await expect(page.getByTestId('detail-status-badge')).toContainText('Geplant');

  // Verify the card is back in the "Geplant" column
  await expect(
    page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
  ).toBeVisible();

  // Step 14 (intermediate): geplant count restored
  await expect(page.getByTestId('column-count-geplant')).toContainText('2');

  // ── Step 11: User changes planned end date via date picker in detail panel ──
  // AC-7: Changing a date updates plannedEnd and persists
  // Both geplant projects have dates from seed data — only end date is changed
  const endDateInput = page.getByTestId('detail-date-end');
  await endDateInput.fill('2026-04-25');

  // ── Step 12: User switches to calendar view — project bar reflects the new date ──
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
  // Verify the calendar contains the day cell for the new planned end date
  await expect(page.getByTestId('calendar-day-2026-04-25')).toBeVisible();

  // ── Step 13: User clicks "X Projekte ohne Termin" — switches to filtered Kanban ──
  // AC-10: "X Projekte ohne Termin" counter appears below calendar
  const noDatesCounter = page.getByTestId('no-dates-counter');
  await expect(noDatesCounter).toBeVisible();
  await expect(noDatesCounter).toContainText('Projekte ohne Termin');
  await noDatesCounter.click();

  // Should be back on Kanban filtered to projects without dates.
  // Our tested project has dates — it must NOT appear in the dateless filter.
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await expect(page.getByTestId(`project-card-${projectId}`)).not.toBeVisible();
  // Verify dateless projects are actually shown
  const visibleCards = page.locator('[data-testid^="project-card-"]');
  const cardCount = await visibleCards.count();
  expect(cardCount).toBeGreaterThan(0);

  // ── Step 14: Summary area reflects current state counts throughout ──
  // AC-8: Verified at intermediate points above and once more here
  await expect(page.getByTestId('summary-area')).toBeVisible();
  // Rechnung fällig should still be 3 (tested project was moved back to geplant)
  await expect(page.getByTestId('summary-action-rechnung_faellig')).toContainText('3');

  // ── Step 15: User refreshes the page — changes persist; user remains logged in ──
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

  // The date change from step 11 persisted — verify via detail panel
  await page.getByTestId(`project-card-${projectId}`).click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  await expect(page.getByTestId('detail-date-end')).toHaveValue('2026-04-25');
  await page.getByTestId('detail-close').click();

  // ── Step 16: User clicks "Abmelden" — login screen appears ──
  // AC-25: Clicking "Abmelden" logs out and shows login screen
  await page.getByTestId('user-indicator').click();
  await page.getByTestId('logout-button').click();

  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByTestId('kanban-board')).not.toBeVisible();

  // ── Step 17: Pressing browser back button does not show project data ──
  // AC-26: After logout, back button must not reveal project data
  await page.goBack();
  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByTestId('kanban-board')).not.toBeVisible();
  await expect(page.getByTestId(`project-card-${projectId}`)).not.toBeVisible();
});
