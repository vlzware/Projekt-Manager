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
  /** `data:export` — gates Daten tab visibility and the export action. */
  canExportData: boolean;
  /** `data:restore` — gates the import form inside the Daten view. */
  canRestoreData: boolean;
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
    canExportData: true,
    canRestoreData: true,
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
    canExportData: true,
    canRestoreData: false,
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
    canExportData: false,
    canRestoreData: false,
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
    canExportData: false,
    canRestoreData: false,
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

      // -- Daten (unified data-exchange) view ----------------------------
      // AC-142: the Daten tab itself is gated on `data:export`. Roles
      // without it must not see the nav toggle at all. Inside the view,
      // the import sub-form is gated on `data:restore` (owner only).
      await expect(page.getByTestId('view-toggle-daten')).toHaveCount(
        c.canExportData ? 1 : 0,
      );
      if (c.canExportData) {
        await page.getByTestId('view-toggle-daten').click();
        await page.getByTestId('daten-view').waitFor();

        await expect(page.getByTestId('data-export-button')).toHaveCount(1);
        await expect(page.getByTestId('data-import-file-input')).toHaveCount(
          c.canRestoreData ? 1 : 0,
        );
      }

      // -- Benutzer management view (only if user:read) ------------------
      if (c.canReadUsers) {
        await page.getByTestId('view-toggle-benutzer').click();
        await page.getByTestId('user-table').locator('tbody tr').first().waitFor();

        await expect(page.getByTestId('user-create-button')).toHaveCount(
          c.canManageUsers ? 1 : 0,
        );

        // Open a user detail to check the management action buttons.
        // Target `buchhalter` — always active and never the logged-in
        // user (owner or office), so deactivate visibility reflects
        // `user:manage` and delete visibility reflects `user:delete`,
        // without interference from the self-delete guard or the
        // inactive-user reactivate branch. Picked by content because
        // the list API does not guarantee row order (repositories/user.ts
        // has no ORDER BY — tracked separately).
        const targetRow = page
          .getByTestId('user-table')
          .locator('tbody tr', { hasText: 'buchhalter' });
        await expect(targetRow).toHaveCount(1);
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
