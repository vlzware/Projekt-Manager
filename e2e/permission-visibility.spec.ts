import { test, expect, type Page } from '@playwright/test';

/**
 * Permission-based UI visibility (AC-121 [crit]).
 *
 * Verifies that every action-triggering UI control is hidden for users
 * whose roles do not grant the backing permission. This is the client
 * side of the `requirePermission` contract — the server is always
 * authoritative, but rendering an affordance that always 403s is
 * misleading state (ADR-0014 Tier-1).
 *
 * Each role logs in fresh (storageState override) so the suite exercises
 * each role's derived `usePermission(...)` result in a real render,
 * not against a mock. Login round-trips stay well within the dev server
 * rate-limit (LOGIN_RATE_LIMIT_MAX=30 — see playwright.config.ts).
 *
 * Asserts with toHaveCount / toBeHidden — NOT screenshots — because this
 * is a critical AC, not a design AC.
 */

type Role = 'owner' | 'office' | 'worker' | 'bookkeeper';

interface RoleCase {
  username: string;
  canReadUsers: boolean;
  canManageUsers: boolean;
  canDeleteUsers: boolean;
  canExtract: boolean;
  canCreateProject: boolean;
  canUpdateProject: boolean;
  canDeleteProject: boolean;
  canTransition: boolean;
  canUpdateDates: boolean;
  canCreateCustomer: boolean;
  canDeleteCustomer: boolean;
  canImport: boolean;
}

/**
 * Expected visibility derived from ROLE_PERMISSIONS in
 * `src/config/permissions.ts`. Keep in sync when the matrix changes.
 */
const roleCases: Record<Role, RoleCase> = {
  owner: {
    username: 'inhaber',
    canReadUsers: true,
    canManageUsers: true,
    canDeleteUsers: true,
    canExtract: true,
    canCreateProject: true,
    canUpdateProject: true,
    canDeleteProject: true,
    canTransition: true,
    canUpdateDates: true,
    canCreateCustomer: true,
    canDeleteCustomer: true,
    canImport: true,
  },
  office: {
    username: 'buero',
    canReadUsers: true,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: true,
    canCreateProject: true,
    canUpdateProject: true,
    canDeleteProject: true,
    canTransition: true,
    canUpdateDates: true,
    canCreateCustomer: true,
    canDeleteCustomer: false,
    canImport: true,
  },
  worker: {
    username: 'arbeiter1',
    canReadUsers: false,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: false,
    canCreateProject: false,
    canUpdateProject: false,
    canDeleteProject: false,
    canTransition: false,
    canUpdateDates: false,
    canCreateCustomer: false,
    canDeleteCustomer: false,
    canImport: false,
  },
  bookkeeper: {
    username: 'buchhalter',
    canReadUsers: false,
    canManageUsers: false,
    canDeleteUsers: false,
    canExtract: false,
    canCreateProject: false,
    canUpdateProject: false,
    canDeleteProject: false,
    canTransition: false,
    canUpdateDates: false,
    canCreateCustomer: false,
    canDeleteCustomer: false,
    canImport: false,
  },
};

async function loginAs(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill('changeme');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('kanban-board').waitFor();
}

test.describe('AC-121: permission-based UI visibility', () => {
  // Each test logs in fresh — override the shared authenticated storage state.
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const [role, c] of Object.entries(roleCases) as [Role, RoleCase][]) {
    test(`${role} — action controls match ROLE_PERMISSIONS`, async ({ page }) => {
      await loginAs(page, c.username);

      // -- Header navigation and extract button --------------------------
      await expect(page.getByTestId('view-toggle-benutzer')).toHaveCount(c.canReadUsers ? 1 : 0);
      await expect(page.getByTestId('extract-button')).toHaveCount(c.canExtract ? 1 : 0);

      // -- Kanban card forward arrow (any card in a transitionable state) --
      const cardForwardCount = await page.locator('[data-testid^="forward-button-"]').count();
      if (c.canTransition) {
        expect(cardForwardCount).toBeGreaterThan(0);
      } else {
        expect(cardForwardCount).toBe(0);
      }

      // -- Project detail panel (open first card) ------------------------
      await page.locator('[data-testid^="project-card-"]').first().click();
      await page.getByTestId('detail-panel').waitFor();

      const detailForward = await page.getByTestId('detail-forward-button').count();
      const detailBackward = await page.getByTestId('detail-backward-button').count();
      if (c.canTransition) {
        // Anfrage hides backward, Erledigt hides forward — but every state
        // allows at least one direction, so the sum is ≥ 1 when permitted.
        expect(detailForward + detailBackward).toBeGreaterThan(0);
      } else {
        expect(detailForward).toBe(0);
        expect(detailBackward).toBe(0);
      }

      await expect(page.getByTestId('detail-date-start')).toHaveCount(c.canUpdateDates ? 1 : 0);
      await expect(page.getByTestId('detail-date-end')).toHaveCount(c.canUpdateDates ? 1 : 0);

      await page.getByTestId('detail-close').click();

      // -- Projekte management view --------------------------------------
      await page.getByTestId('view-toggle-projekte').click();
      await page.getByTestId('project-table').locator('tbody tr').first().waitFor();

      await expect(page.getByTestId('project-create-button')).toHaveCount(
        c.canCreateProject ? 1 : 0,
      );

      const projectDeleteBtns = page
        .getByTestId('project-table')
        .locator('tbody button', { hasText: /löschen/i });
      if (c.canDeleteProject) {
        expect(await projectDeleteBtns.count()).toBeGreaterThan(0);
      } else {
        expect(await projectDeleteBtns.count()).toBe(0);
      }

      // Edit-form Save button: click into first row to open the form.
      // For worker/bookkeeper the form opens but Save is hidden — no
      // mutation trigger, so the "details view" is the intentional fallback.
      await page.getByTestId('project-table').locator('tbody tr').first().click();
      await expect(page.getByTestId('project-save')).toHaveCount(c.canUpdateProject ? 1 : 0);
      await page.getByRole('button', { name: 'Abbrechen' }).click();

      // -- Kunden management view ----------------------------------------
      await page.getByTestId('view-toggle-kunden').click();
      await page.getByTestId('customer-table').locator('tbody tr').first().waitFor();

      await expect(page.getByTestId('customer-create-button')).toHaveCount(
        c.canCreateCustomer ? 1 : 0,
      );

      const customerDeleteBtns = page
        .getByTestId('customer-table')
        .locator('tbody button', { hasText: /löschen/i });
      if (c.canDeleteCustomer) {
        expect(await customerDeleteBtns.count()).toBeGreaterThan(0);
      } else {
        expect(await customerDeleteBtns.count()).toBe(0);
      }

      // -- Daten (Import/Export) view ------------------------------------
      // AC-90: import section hidden when user has neither project:create
      // nor customer:write. Export section always visible (all roles have
      // project:read and customer:read).
      await page.getByTestId('view-toggle-daten').click();
      await page.getByTestId('import-export-view').waitFor();

      await expect(page.getByTestId('import-entity-select')).toHaveCount(c.canImport ? 1 : 0);
      await expect(page.getByTestId('export-entity-select')).toHaveCount(1);

      // -- Benutzer management view (only if user:read) ------------------
      if (c.canReadUsers) {
        await page.getByTestId('view-toggle-benutzer').click();
        await page.getByTestId('user-table').locator('tbody tr').first().waitFor();

        await expect(page.getByTestId('user-create-button')).toHaveCount(
          c.canManageUsers ? 1 : 0,
        );

        // Open a user detail to check the management action buttons.
        // Pick a user row that is NOT the currently logged-in user so the
        // Löschen visibility is governed by user:delete, not the self-
        // delete guard. For owner/office the first row is typically the
        // owner themselves, so pick the second row.
        const userRows = page.getByTestId('user-table').locator('tbody tr');
        const targetRow = (await userRows.count()) > 1 ? userRows.nth(1) : userRows.first();
        await targetRow.click();

        await expect(page.getByTestId('user-deactivate-button')).toHaveCount(
          c.canManageUsers ? 1 : 0,
        );
        await expect(page.getByTestId('user-reset-pw-button')).toHaveCount(
          c.canManageUsers ? 1 : 0,
        );
        await expect(page.getByTestId('user-delete-button')).toHaveCount(
          c.canDeleteUsers ? 1 : 0,
        );
      }
    });
  }
});
