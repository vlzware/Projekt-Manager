import { test, expect, type Page } from '@playwright/test';

/**
 * Regression for #130 — clicking outside an open menu must close the menu
 * WITHOUT activating the element under the cursor.
 *
 * The fix is `src/ui/common/MenuBackdrop.tsx`: a transparent fixed-inset
 * layer rendered as a sibling immediately before the dropdown. The browser
 * hit-tests the backdrop first (z-index 55, above non-positioned page
 * content) and the click that closes the menu never reaches the element
 * underneath.
 *
 * Test mechanics
 * --------------
 * `locator.click()` runs Playwright's actionability check, including
 * "receives pointer events." With the fix in place, the backdrop sits
 * over every nav button — so a `locator.click()` on a nav button while
 * the menu is open would block on hit-testing rather than reproducing the
 * user-perceived sequence. The test therefore uses `page.mouse.click(x, y)`
 * at the target's bounding-box centre so the browser performs the real
 * hit-test and we observe the fix's actual effect.
 *
 * Without the fix, the same coordinate click would land on the nav button
 * (the buggy `mousedown`-listener path closed the menu but propagation
 * still reached the button) and the assertion `URL did not change` would
 * fail.
 */

async function clickAtCenter(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`bounding box not available for ${testId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe('MenuBackdrop — outside click closes menu without activating target (#130)', () => {
  test.beforeEach(async ({ page }) => {
    // Anchor on /projects so a sibling tab (kanban) is the click target
    // and a successful regression shows up as "URL unchanged".
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByTestId('header')).toBeVisible();
  });

  test('user menu open + click on a primary nav tab: menu closes, navigation does not happen', async ({
    page,
  }) => {
    await page.getByTestId('user-menu-trigger').click();
    // `logout-button` only exists while the dropdown is mounted.
    await expect(page.getByTestId('logout-button')).toBeVisible();

    await clickAtCenter(page, 'view-toggle-kanban');

    await expect(page.getByTestId('logout-button')).toHaveCount(0);
    await expect(page).toHaveURL(/\/projects$/);
  });

  test('admin menu open + click on a primary nav tab: menu closes, navigation does not happen', async ({
    page,
  }) => {
    await page.getByTestId('nav-admin-trigger').click();
    // `view-toggle-benutzer` is in the secondary set for owner — only
    // attached to the DOM while the admin dropdown is open.
    await expect(page.getByTestId('view-toggle-benutzer')).toBeVisible();

    await clickAtCenter(page, 'view-toggle-kanban');

    await expect(page.getByTestId('view-toggle-benutzer')).toHaveCount(0);
    await expect(page).toHaveURL(/\/projects$/);
  });
});
