import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for design acceptance criteria.
 *
 * Design ACs verify expected behavior that does not guard a critical path
 * (layout, interaction flow, status display, sorting, visual state).
 * They are verified by screenshot comparison rather than DOM assertions.
 * See CONTRIBUTING.md § Acceptance Criteria for the full policy.
 *
 * Baseline workflow:
 *   1. Run `npx playwright test visual-regression --update-snapshots`
 *      to create or update baselines
 *   2. Commit the generated snapshots directory
 *   3. Subsequent runs compare against the committed baselines
 *
 * Platform note: screenshot baselines are platform-dependent (font
 * rendering differs across OSes). Generate baselines on the same
 * platform used for CI (Linux / ubuntu-latest) for consistent results.
 */

test.describe('Kanban board', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();
  });

  test('board layout', async ({ page }) => {
    await expect(page).toHaveScreenshot('kanban-board.png', { fullPage: true });
  });
});

test.describe('Login page', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login form layout', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-form').waitFor();
    await expect(page).toHaveScreenshot('login-page.png', { fullPage: true });
  });
});
