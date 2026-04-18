import { test, expect, type Page } from '@playwright/test';

/**
 * Structural E2E for the backup-freshness badge surfaces (AC-170 [vis]).
 *
 * AC-170 pins three visibility claims:
 *
 *   1. The badge is rendered on the login screen regardless of auth
 *      state. Network reach to the login screen is VPN-gated per
 *      ADR-0008; the unauthenticated surface is the operator's only
 *      read path when the app DB is also down.
 *   2. On the authenticated admin landing view, the badge is visible
 *      only to callers with role `owner`.
 *   3. On any other authenticated surface — other roles' landings,
 *      non-landing routes — the badge is not rendered.
 *
 * Verified structurally (presence / absence of `[data-testid="backup-badge"]`),
 * never by pixel-diff. Structural assertions are the project convention
 * for `[vis]` ACs — screenshot baselines were dropped as brittle friction
 * (see playwright.config.ts comment on `trace: 'retain-on-failure'`).
 *
 * Runs under the shared `chromium` read-only project: login rounds trip
 * for each role test, so `test.use({ storageState: ... })` overrides the
 * shared authenticated state with a fresh context.
 *
 * ---------------------------------------------------------------------
 * Test-id inventory (this spec's contract with the UI)
 * ---------------------------------------------------------------------
 *
 * Already implemented (verified against the current tree):
 *   - login-form         src/ui/auth/LoginForm.tsx
 *   - login-username     src/ui/auth/LoginForm.tsx
 *   - login-password     src/ui/auth/LoginForm.tsx
 *   - login-submit       src/ui/auth/LoginForm.tsx
 *   - header             src/ui/layout/Header.tsx
 *   - view-toggle-kunden src/ui/layout/Header.tsx (generated from routes)
 *   - customer-table     src/ui/management/CustomerManagement.tsx
 *
 * Phase 3 UI must add these as data-testid attributes:
 *   - backup-badge       The freshness-badge component (login screen +
 *                        owner landing). `toHaveCount(0 | 1)` is used in
 *                        this spec to distinguish "not rendered" from
 *                        "CSS-hidden" per AC-170 wording.
 */

type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

interface RoleCase {
  username: string;
  badgeOnLanding: boolean;
}

/**
 * Seeded usernames + expected badge visibility on the role's landing
 * view. Owner is the only role whose landing shows the badge — that
 * is the claim AC-170 pins.
 */
const ROLE_CASES: Record<Role, RoleCase> = {
  owner: { username: 'inhaber', badgeOnLanding: true },
  office: { username: 'buero', badgeOnLanding: false },
  worker: { username: 'arbeiter1', badgeOnLanding: false },
  bookkeeper: { username: 'buchhalter', badgeOnLanding: false },
};

async function loginAs(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill('changeme');
  await page.getByTestId('login-submit').click();
  // Wait for the shared authenticated layout — `header` renders on
  // every role's landing view. Using `header` (not `kanban-board`)
  // avoids hanging for bookkeeper, whose landing is `/projects`.
  await page.getByTestId('header').waitFor();
}

test.describe('AC-170: backup-freshness badge surfaces', () => {
  // Every test below needs a fresh context — the shared storage state
  // from auth.setup.ts would otherwise log the page in as owner before
  // the "anonymous login screen shows badge" assertion can run.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login screen renders the badge for an unauthenticated visitor', async ({ page }) => {
    await page.goto('/');

    // Login form is visible — we are on the unauth surface.
    await expect(page.getByTestId('login-form')).toBeVisible();

    // Badge is rendered here regardless of auth — VPN is the
    // threat-model anchor per ADR-0008, so the login screen is a
    // trusted read surface even without an active session.
    await expect(page.getByTestId('backup-badge')).toBeVisible();
  });

  for (const [role, c] of Object.entries(ROLE_CASES) as [Role, RoleCase][]) {
    test(`authenticated landing — badge ${c.badgeOnLanding ? 'visible' : 'hidden'} for ${role}`, async ({
      page,
    }) => {
      await loginAs(page, c.username);

      // Assert-against-the-claim: owner's landing shows the badge;
      // every other role's landing does not render it at all.
      // `toHaveCount(0 | 1)` instead of `toBeVisible` / `toBeHidden`
      // to make "not rendered" (absent from the DOM) explicit — a
      // CSS-hidden badge would still pass `toBeHidden` and would
      // violate AC-170's "not rendered" wording.
      const badge = page.getByTestId('backup-badge');
      await expect(badge).toHaveCount(c.badgeOnLanding ? 1 : 0);
    });
  }

  test('non-landing authenticated surface does not render the badge for owner', async ({
    page,
  }) => {
    // Owner sees the badge on the admin landing, but the spec limits
    // that surface to the landing. Navigating to another authenticated
    // route (here: customers) must drop the badge from the render.
    await loginAs(page, ROLE_CASES.owner.username);

    // Navigate to Kunden — any non-landing route is valid; Kunden is
    // stable for owner across role-matrix changes.
    await page.getByTestId('view-toggle-kunden').click();
    await page.getByTestId('customer-table').waitFor();

    // Badge must not render on this surface, regardless of role.
    await expect(page.getByTestId('backup-badge')).toHaveCount(0);
  });
});
