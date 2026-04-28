import { expect, type Page } from '@playwright/test';

/**
 * Nav-affordance helpers that abstract over the header's primary/
 * secondary layout.
 *
 * The header partitions views into a primary row and a "Verwaltung"
 * (admin) dropdown (see src/ui/layout/Header.tsx). For roles with ≥2
 * secondary views the menu is rendered; otherwise the view buttons sit
 * inline. These helpers let specs express intent — "click the Benutzer
 * tab" — without caring which bucket the route lands in for the current
 * role.
 *
 * Test IDs (`view-toggle-<view>`) are shared across both renderings, so
 * a visibility check after opening the menu works uniformly.
 */

export type NavViewKey =
  | 'kanban'
  | 'kalender'
  | 'projekte'
  | 'kunden'
  | 'benutzer'
  | 'daten'
  | 'aktivitaet'
  | 'benachrichtigungen';

/**
 * Wait until the header has finished rendering. Counts taken before
 * this point race the initial paint and return 0 for segments that
 * will appear a tick later — which then misroutes
 * `clickView` / `expectViewReachable` into the admin-menu branch.
 */
async function waitForHeader(page: Page): Promise<void> {
  await page.getByTestId('header').waitFor({ state: 'visible' });
}

/**
 * Close the open admin (or any) menu by clicking through the
 * MenuBackdrop sitting on top of `triggerTestId`. A plain
 * `locator.click()` fails Playwright's actionability check ("backdrop
 * intercepts pointer events") because the backdrop covers every page
 * element while a menu is open — see src/ui/common/MenuBackdrop.tsx
 * (#130). `page.mouse.click(x, y)` performs the real browser hit-test
 * at the coordinate, lands on the backdrop (z-index 55), and the
 * backdrop's onClick closes the menu — the same path a real user
 * triggers by clicking outside an open dropdown. Mirrors the pattern
 * already used in e2e/menu-backdrop.spec.ts.
 */
async function closeMenuViaBackdrop(page: Page, triggerTestId: string): Promise<void> {
  const box = await page.getByTestId(triggerTestId).boundingBox();
  if (!box) throw new Error(`bounding box not available for ${triggerTestId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Click a view nav entry. If the header has a "Verwaltung" admin menu
 * and the target view lives inside it, the menu is opened first. Otherwise
 * the inline tab is clicked directly.
 */
export async function clickView(page: Page, view: NavViewKey): Promise<void> {
  await waitForHeader(page);
  const inline = page.getByTestId(`view-toggle-${view}`);
  if (await inline.count()) {
    await inline.click();
    return;
  }
  const adminTrigger = page.getByTestId('nav-admin-trigger');
  await adminTrigger.click();
  await page.getByTestId(`view-toggle-${view}`).click();
}

/**
 * Assert that a view is reachable from the current role's nav —
 * whether inline or via the admin menu. Handles the closed-menu case
 * transparently. When `reachable` is false, asserts the nav entry is
 * absent from both renderings.
 */
export async function expectViewReachable(
  page: Page,
  view: NavViewKey,
  reachable: boolean,
): Promise<void> {
  await waitForHeader(page);
  if (!reachable) {
    // Not reachable: not inline. If the admin menu exists, open it and
    // confirm the entry is absent from inside too.
    await expect(page.getByTestId(`view-toggle-${view}`)).toHaveCount(0);
    const adminTrigger = page.getByTestId('nav-admin-trigger');
    if (await adminTrigger.count()) {
      await adminTrigger.click();
      await expect(page.getByTestId(`view-toggle-${view}`)).toHaveCount(0);
      // Close the menu so subsequent assertions don't race it.
      await closeMenuViaBackdrop(page, 'nav-admin-trigger');
    }
    return;
  }
  // Reachable: either inline, or inside the admin menu.
  const inline = page.getByTestId(`view-toggle-${view}`);
  if (await inline.count()) {
    await expect(inline).toHaveCount(1);
    return;
  }
  const adminTrigger = page.getByTestId('nav-admin-trigger');
  await expect(adminTrigger).toHaveCount(1);
  await adminTrigger.click();
  await expect(page.getByTestId(`view-toggle-${view}`)).toHaveCount(1);
  await closeMenuViaBackdrop(page, 'nav-admin-trigger');
}
