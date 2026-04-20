import { expect, type Page, type Locator } from '@playwright/test';

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
  | 'aktivitaet';

/**
 * Click a view nav entry. If the header has a "Verwaltung" admin menu
 * and the target view lives inside it, the menu is opened first. Otherwise
 * the inline tab is clicked directly.
 */
export async function clickView(page: Page, view: NavViewKey): Promise<void> {
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
 * Returns the locator for a view's nav entry, opening the admin menu
 * first if the entry lives inside it. For `expectViewReachable` /
 * `expectViewNotReachable` helpers. Callers can still call `.count()`
 * on the returned locator when the menu is absent (no trigger) — the
 * locator will resolve to zero as expected.
 */
export async function resolveViewLocator(page: Page, view: NavViewKey): Promise<Locator> {
  const inline = page.getByTestId(`view-toggle-${view}`);
  if (await inline.count()) return inline;
  const adminTrigger = page.getByTestId('nav-admin-trigger');
  if (await adminTrigger.count()) {
    await adminTrigger.click();
    return page.getByTestId(`view-toggle-${view}`);
  }
  return inline;
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
  if (!reachable) {
    // Not reachable: not inline. If the admin menu exists, open it and
    // confirm the entry is absent from inside too.
    await expect(page.getByTestId(`view-toggle-${view}`)).toHaveCount(0);
    const adminTrigger = page.getByTestId('nav-admin-trigger');
    if (await adminTrigger.count()) {
      await adminTrigger.click();
      await expect(page.getByTestId(`view-toggle-${view}`)).toHaveCount(0);
      // Close the menu so subsequent assertions don't race it.
      await adminTrigger.click();
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
  await adminTrigger.click();
}
