import { test, expect } from '@playwright/test';

test('E2E Smoke Test: full interaction path', async ({ page }) => {
  // Step 1: App loads — Kanban view is displayed with 9 columns
  await page.goto('/');
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

  // Step 2: Summary area shows "3× Rechnung fällig"
  const summaryArea = page.getByTestId('summary-area');
  await expect(summaryArea).toBeVisible();
  const rechnungIndicator = page.getByTestId('summary-action-rechnung_faellig');
  await expect(rechnungIndicator).toContainText('3');
  await expect(rechnungIndicator).toContainText('Rechnung fällig');

  // Step 3: User clicks a summary indicator — view filters to matching projects
  await rechnungIndicator.click();

  // Only rechnung_faellig column should have cards
  await expect(page.getByTestId('column-count-rechnung_faellig')).toContainText('3');
  await expect(page.getByTestId('column-count-anfrage')).toContainText('0');

  // Step 4: User clicks "Filter aufheben" — full view restored
  const clearFilter = page.getByTestId('clear-filter');
  await expect(clearFilter).toBeVisible();
  await clearFilter.click();
  await expect(page.getByTestId('column-count-anfrage')).toContainText('2');

  // Step 5: User clicks a card in Geplant — detail panel opens
  const geplantCard = page.getByTestId('project-card-p07');
  await geplantCard.click();
  const detailPanel = page.getByTestId('detail-panel');
  await expect(detailPanel).toBeVisible();
  await expect(detailPanel).toContainText('Wohnzimmer renovieren Klein');

  // Step 6: User clicks "Nächster Schritt" — confirmation dialog appears
  // Step 7: User confirms — card moves to In Arbeit
  // Finding 17: use page.once instead of page.on + removeAllListeners
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Geplant → In Arbeit');
    await dialog.accept();
  });
  await page.getByTestId('detail-forward-button').click();

  // Wait for status badge to update
  await expect(page.getByTestId('detail-status-badge')).toContainText('In Arbeit');

  // Finding 2 (R2): mid-test summary assertion — "throughout" means checking at intermediate points
  // After step 7: p07 moved from geplant to in_arbeit, so geplant count should decrease
  await expect(page.getByTestId('column-count-geplant')).toContainText('1');

  // Step 8: User clicks "Vorheriger Schritt" — card moves back to Geplant
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('In Arbeit → Geplant');
    await dialog.accept();
  });
  await page.getByTestId('detail-backward-button').click();
  await expect(page.getByTestId('detail-status-badge')).toContainText('Geplant');

  // Finding 2 (R2): after step 8, geplant count should be restored
  await expect(page.getByTestId('column-count-geplant')).toContainText('2');

  // Step 9: User changes planned end date via date picker in detail panel
  // Finding 8: use a date within April so the calendar (which defaults to current month) can show it
  const endDateInput = page.getByTestId('detail-date-end');
  await endDateInput.fill('2026-04-25');

  // Step 10: User switches to calendar view — the project bar reflects the new date
  // Close detail panel first
  await page.getByTestId('detail-close').click();
  await expect(detailPanel).not.toBeVisible();

  const calendarToggle = page.getByTestId('view-toggle-kalender');
  await calendarToggle.click();
  await expect(page.getByTestId('calendar-view')).toBeVisible();
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  // Finding 8: assert the project bar for p07 is actually visible in the calendar
  await expect(page.getByTestId('calendar-bar-p07').first()).toBeVisible();

  // Step 11: User clicks "X Projekte ohne Termin" — switches to filtered Kanban
  // Finding 9: spec is ambiguous whether this should filter to dateless projects or just switch views.
  // Current implementation switches to kanban without filtering. Spec clarification candidate.
  const noDatesCounter = page.getByTestId('no-dates-counter');
  await expect(noDatesCounter).toBeVisible();
  await expect(noDatesCounter).toContainText('Projekte ohne Termin');
  await noDatesCounter.click();

  // Should be back on Kanban
  await expect(page.getByTestId('kanban-board')).toBeVisible();

  // Step 12: Summary area reflects current state counts throughout
  await expect(page.getByTestId('summary-area')).toBeVisible();
  // Rechnung fällig should still be 3 (we moved p07 back)
  await expect(page.getByTestId('summary-action-rechnung_faellig')).toContainText('3');
});
