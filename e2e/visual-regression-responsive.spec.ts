/**
 * Visual regression tests for responsive column collapse tiers.
 *
 * The Kanban board collapses columns in three tiers as the viewport
 * narrows (spec ui.md §10, AC-41 through AC-44):
 *
 *   Tier 3 (<1780px): Angebot, Abgerechnet, Erledigt
 *   Tier 2 (<1350px): Geplant, In Arbeit, Abnahme
 *   Tier 1 ( <940px): Anfrage, Beauftragt, Rechnung fällig
 *
 * Collapsed columns show a slim indicator with header and card count;
 * cards are hidden. Clicking a collapsed column expands it; clicking
 * the header again re-collapses it.
 *
 * Each describe block overrides the viewport via `test.use()` so
 * screenshots capture the correct breakpoint. The full-width reference
 * screenshot (1920px) serves as a visual baseline for comparison.
 */
import { test, expect } from '@playwright/test';

// -- Full-width reference (1920px) ----------------------------------------

test.describe('Responsive: full-width reference', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('all columns expanded at full width', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();
    await expect(page).toHaveScreenshot('responsive-full-width.png', { fullPage: true });
  });
});

// -- AC-41: Tier-3 collapse (<1780px) -------------------------------------

test.describe('AC-41: Tier-3 collapse below 1780px', () => {
  test.use({ viewport: { width: 1779, height: 1080 } });

  test('tier-3 columns collapsed', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();
    await expect(page).toHaveScreenshot('responsive-tier3-collapsed.png', { fullPage: true });
  });
});

// -- AC-42: Tier-2 collapse (<1350px) -------------------------------------

test.describe('AC-42: Tier-2 collapse below 1350px', () => {
  test.use({ viewport: { width: 1349, height: 1080 } });

  test('tier-2 columns collapsed', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();
    await expect(page).toHaveScreenshot('responsive-tier2-collapsed.png', { fullPage: true });
  });
});

// -- AC-43: Tier-1 collapse (<940px) --------------------------------------

test.describe('AC-43: Tier-1 collapse below 940px', () => {
  test.use({ viewport: { width: 939, height: 1080 } });

  test('tier-1 columns collapsed', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();
    await expect(page).toHaveScreenshot('responsive-tier1-collapsed.png', { fullPage: true });
  });
});

// -- AC-44: Expand / collapse interaction ---------------------------------

test.describe('AC-44: expand and re-collapse a collapsed column', () => {
  test.use({ viewport: { width: 1779, height: 1080 } });

  test('clicking collapsed column toggles expansion', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();

    const column = page.getByTestId('kanban-column-angebot');

    // 1. Collapsed state (tier-3 active)
    await expect(page).toHaveScreenshot('responsive-column-collapsed-before.png', { fullPage: true });

    // 2. Click the column header to expand
    await column.click();
    await expect(page).toHaveScreenshot('responsive-column-expanded.png', { fullPage: true });

    // 3. Click the header again to re-collapse
    await column.click();
    await expect(page).toHaveScreenshot('responsive-column-recollapsed.png', { fullPage: true });
  });
});
