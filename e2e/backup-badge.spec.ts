import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * Structural E2E for the backup-freshness badge surface (AC-170 [vis]).
 *
 * AC-170 pins two visibility claims:
 *
 *   1. The badge is NOT rendered on the unauthenticated login screen.
 *      The login surface is auth-only — health affordances belong on
 *      authenticated views where the operator can act on them.
 *   2. On the authenticated admin landing view, the badge is visible
 *      only to callers with role `owner`. On any other authenticated
 *      surface — other roles' landings, non-landing routes — the
 *      badge is not rendered.
 *
 * Verified structurally (presence / absence of `[data-testid="backup-badge"]`),
 * never by pixel-diff. Structural assertions are the project convention
 * for `[vis]` ACs.
 */

type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

/**
 * Expected badge visibility on each role's landing view. Owner is the
 * only role whose landing shows the badge — that is the claim AC-170
 * pins.
 */
const BADGE_ON_LANDING: Record<Role, boolean> = {
  owner: true,
  office: false,
  worker: false,
  bookkeeper: false,
};

test.describe('AC-170: backup-freshness badge — unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login screen does not render the badge', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('backup-badge')).toHaveCount(0);
  });
});

test.describe('AC-170: backup-freshness badge — authenticated landing per role', () => {
  for (const [role, visible] of Object.entries(BADGE_ON_LANDING) as [Role, boolean][]) {
    test.describe(role, () => {
      test.use({ storageState: STORAGE_STATES[role] });
      test(`badge ${visible ? 'visible' : 'hidden'} on landing`, async ({ page }) => {
        await page.goto('/');

        // Assert-against-the-claim: owner's landing shows the badge;
        // every other role's landing does not render it at all.
        // `toHaveCount(0 | 1)` instead of `toBeVisible` / `toBeHidden`
        // to make "not rendered" (absent from the DOM) explicit — a
        // CSS-hidden badge would still pass `toBeHidden` and would
        // violate AC-170's "not rendered" wording.
        const badge = page.getByTestId('backup-badge');
        await expect(badge).toHaveCount(visible ? 1 : 0);
      });
    });
  }
});

test.describe('AC-170: backup-freshness badge — owner non-landing surface', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('non-landing authenticated surface does not render the badge for owner', async ({
    page,
  }) => {
    // Owner sees the badge on the admin landing, but the spec limits
    // that surface to the landing. Navigating to another authenticated
    // route (here: customers) must drop the badge from the render.
    await page.goto('/');

    // Navigate to Kunden — any non-landing route is valid; Kunden is
    // stable for owner across role-matrix changes.
    await page.getByTestId('view-toggle-kunden').click();
    await page.getByTestId('customer-table').waitFor();

    // Badge must not render on this surface, regardless of role.
    await expect(page.getByTestId('backup-badge')).toHaveCount(0);
  });
});
