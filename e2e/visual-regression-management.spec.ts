/**
 * Visual regression tests for management views and navigation.
 *
 * These are TDD screenshot tests — they capture the visual state of
 * project, customer, user management views and the navigation bar,
 * then verify nothing regresses between runs.
 *
 * Baseline workflow:
 *   1. Run `npx playwright test visual-regression-management --update-snapshots`
 *   2. Commit the generated snapshots directory
 *   3. Subsequent runs compare against the committed baselines
 *
 * Some tests create data (prefixed "VR-" / "Visual Regression") to
 * exercise create/edit/delete flows. The database is reseeded before
 * each Playwright invocation via auth.setup.ts, so residue does not
 * accumulate across runs.
 */
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Navigation (authenticated as owner)
// ---------------------------------------------------------------------------
test.describe('Navigation views', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();
  });

  // AC-74 [vis]: each navigation target renders correctly
  test('navigate to each view and screenshot', async ({ page }) => {
    const views = [
      { toggle: 'view-toggle-kanban', wait: 'kanban-board', file: 'nav-kanban.png' },
      { toggle: 'view-toggle-kalender', wait: 'calendar-view', file: 'nav-calendar.png' },
      { toggle: 'view-toggle-projekte', wait: 'project-table', file: 'nav-projects.png' },
      { toggle: 'view-toggle-kunden', wait: 'customer-table', file: 'nav-customers.png' },
      { toggle: 'view-toggle-benutzer', wait: 'user-table', file: 'nav-users.png' },
      { toggle: 'view-toggle-daten', wait: 'import-export-view', file: 'nav-import-export.png' },
    ];

    for (const v of views) {
      await page.getByTestId(v.toggle).click();
      await page.getByTestId(v.wait).waitFor();
      await expect(page).toHaveScreenshot(v.file, { fullPage: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Navigation permissions (worker role)
// ---------------------------------------------------------------------------
test.describe('Navigation permissions', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // AC-75 [vis]: worker sees restricted navigation
  test('worker role navigation bar', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-username').fill('arbeiter1');
    await page.getByTestId('login-password').fill('changeme');
    await page.getByTestId('login-submit').click();
    await page.getByTestId('kanban-board').waitFor();

    await expect(page).toHaveScreenshot('nav-worker-role.png', { fullPage: true });
  });
});

// ---------------------------------------------------------------------------
// Project management view
// ---------------------------------------------------------------------------
test.describe('Project management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('view-toggle-projekte').click();
    await page.getByTestId('project-table').waitFor();
  });

  // AC-76 [vis]: project table layout
  test('project table', async ({ page }) => {
    await expect(page.getByTestId('project-table')).toHaveScreenshot('project-table.png');
  });

  // AC-77 [vis]: create project flow
  test('create project', async ({ page }) => {
    await page.getByTestId('project-create-button').click();
    await expect(page).toHaveScreenshot('project-create-form.png', { fullPage: true });

    await page.getByTestId('project-number-input').fill('VR-001');
    await page.getByTestId('project-title-input').fill('Visual Regression Test');
    // Open the custom customer dropdown and pick the first entry
    await page.getByTestId('project-customer-select').click();
    await page.getByTestId('project-customer-select').locator('[class*="selectOption"]').first().click();

    await page.getByTestId('project-submit').click();
    await expect(page.getByTestId('project-table')).toHaveScreenshot('project-created.png');
  });

  // AC-78 [vis]: edit project form
  test('edit project', async ({ page }) => {
    // Click the first project row to open edit form
    await page.getByTestId('project-table').locator('tbody tr').first().click();
    await expect(page).toHaveScreenshot('project-edit-form.png', { fullPage: true });
  });

  // AC-79 [vis]: delete project
  test('delete project', async ({ page }) => {
    const firstRow = page.getByTestId('project-table').locator('tbody tr').first();
    const deleteButton = firstRow.getByRole('button', { name: /delete|löschen/i });
    await deleteButton.click();

    await page.getByTestId('confirm-dialog').waitFor();
    await page.getByTestId('confirm-ok').click();

    await expect(page.getByTestId('project-table')).toHaveScreenshot('project-deleted.png');
  });
});

// ---------------------------------------------------------------------------
// Customer management view
// ---------------------------------------------------------------------------
test.describe('Customer management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('view-toggle-kunden').click();
    await page.getByTestId('customer-table').waitFor();
  });

  // AC-80 [vis]: customer table with project counts
  test('customer table', async ({ page }) => {
    await expect(page.getByTestId('customer-table')).toHaveScreenshot('customer-table.png');
  });

  // AC-81 [vis]: create customer, then verify it appears in project dropdown
  test('customer appears in project dropdown', async ({ page }) => {
    await page.getByTestId('customer-create-button').click();
    await page.getByTestId('customer-name-input').fill('VR Test Kunde');
    await page.getByTestId('customer-submit').click();
    await expect(page.getByText('VR Test Kunde')).toBeVisible();

    // Navigate to project creation and verify dropdown contains the customer
    await page.getByTestId('view-toggle-projekte').click();
    await page.getByTestId('project-table').waitFor();
    await page.getByTestId('project-create-button').click();

    const select = page.getByTestId('project-customer-select');
    await select.click();
    await expect(page).toHaveScreenshot('customer-in-dropdown.png', { fullPage: true });
  });

  // AC-85 [vis]: cross-view customer-project flow
  test('customer-project cross-view flow', async ({ page }) => {
    // Create customer
    await page.getByTestId('customer-create-button').click();
    await page.getByTestId('customer-name-input').fill('VR Cross-View Kunde');
    await page.getByTestId('customer-submit').click();
    await expect(page.getByText('VR Cross-View Kunde')).toBeVisible();

    // Create project referencing that customer
    await page.getByTestId('view-toggle-projekte').click();
    await page.getByTestId('project-table').waitFor();
    await page.getByTestId('project-create-button').click();
    await page.getByTestId('project-number-input').fill('VR-FLOW');
    await page.getByTestId('project-title-input').fill('VR Cross-View Project');
    const select = page.getByTestId('project-customer-select');
    await select.click();
    await page.getByText('VR Cross-View Kunde').click();
    await page.getByTestId('project-submit').click();

    await expect(page).toHaveScreenshot('customer-project-flow.png', { fullPage: true });
  });
});

// ---------------------------------------------------------------------------
// User management view
// ---------------------------------------------------------------------------
test.describe('User management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('view-toggle-benutzer').click();
    await page.getByTestId('user-table').waitFor();
  });

  // AC-82 [vis]: user table showing all users
  test('user table', async ({ page }) => {
    await expect(page.getByTestId('user-table')).toHaveScreenshot('user-table.png');
  });

  // AC-83 [vis]: user creation form
  test('user create form', async ({ page }) => {
    await page.getByTestId('user-create-button').click();
    await expect(page).toHaveScreenshot('user-create-form.png', { fullPage: true });
  });

  // AC-84 [vis]: deactivated user row styling
  // Note: depends on seed data containing a deactivated user.
  // If seed data has no deactivated users, this test will fail —
  // update seed data or create+deactivate a user beforehand.
  test('deactivated user styling', async ({ page }) => {
    const deactivatedRow = page.locator('[data-testid="user-table"] tr.deactivated');
    await expect(deactivatedRow.first()).toBeVisible();
    await expect(page.getByTestId('user-table')).toHaveScreenshot('user-deactivated.png');
  });
});
