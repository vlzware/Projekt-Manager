/**
 * E2E failure paths
 *
 * The smoke test covers the happy path. This file covers what happens when
 * things go wrong end-to-end:
 *
 *   1. Network error during a transition — the user sees a German error
 *      banner and the local state does not get corrupted.
 *   2. Session expiry mid-flow — clicking a transition while the session
 *      has been invalidated server-side redirects to the login screen
 *      with the expiry message.
 *
 * These two scenarios are the closest the spec gets to a deployment
 * robustness check (verification.md AC-23, AC-27).
 */

import { test, expect } from '@playwright/test';

test.describe('E2E failure paths', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-username').fill('inhaber');
    await page.getByTestId('login-password').fill('changeme');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  test('network error during transition shows error banner and reverts state', async ({
    page,
  }) => {
    // Inject a network failure on the next transition request.
    await page.route('**/api/projects/*/transition/*', async (route) => {
      await route.abort('failed');
    });

    // Find a project in geplant — this is the same column the smoke test uses.
    const geplantColumn = page.getByTestId('kanban-column-geplant');
    const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
    const cardTestId = await geplantCard.getAttribute('data-testid');
    const projectId = cardTestId!.replace('project-card-', '');

    // Open the detail panel and trigger forward.
    await geplantCard.click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await page.getByTestId('detail-forward-button').click();
    await page.getByTestId('confirm-ok').click();

    // The error banner appears (German, no stack trace).
    const errorBanner = page.locator('text=/fehlgeschlagen|Netzwerk/i').first();
    await expect(errorBanner).toBeVisible();

    // State is unchanged: the project is still in geplant, not in_arbeit.
    await page.getByTestId('detail-close').click();
    await expect(
      page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId('kanban-column-in_arbeit').getByTestId(`project-card-${projectId}`),
    ).not.toBeVisible();
  });

  test('session expiry mid-flow redirects to login with expiry message', async ({ page }) => {
    // Intercept the next transition call and respond with 401 + SESSION_EXPIRED.
    // This simulates the session being invalidated server-side between page
    // load and the user's next action.
    await page.route('**/api/projects/*/transition/*', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SESSION_EXPIRED',
          message: 'Sitzung abgelaufen.',
        }),
      });
    });

    // Open a project and trigger a transition.
    const geplantColumn = page.getByTestId('kanban-column-geplant');
    const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
    await geplantCard.click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await page.getByTestId('detail-forward-button').click();
    await page.getByTestId('confirm-ok').click();

    // The login screen reappears with the German expiry message.
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.locator('text=/Sitzung abgelaufen/i').first()).toBeVisible();
    // The Kanban board is no longer visible.
    await expect(page.getByTestId('kanban-board')).not.toBeVisible();
  });

  test('cancelling the confirmation modal does not transition the project', async ({ page }) => {
    // No network mocking — the test verifies the confirm/cancel UX itself.
    const geplantColumn = page.getByTestId('kanban-column-geplant');
    const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
    const cardTestId = await geplantCard.getAttribute('data-testid');
    const projectId = cardTestId!.replace('project-card-', '');

    await geplantCard.click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await page.getByTestId('detail-forward-button').click();

    // Modal opens — click Abbrechen.
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).not.toBeVisible();

    // Status badge unchanged — still Geplant.
    await expect(page.getByTestId('detail-status-badge')).toContainText('Geplant');

    // Card is still in geplant column after closing the panel.
    await page.getByTestId('detail-close').click();
    await expect(
      page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
    ).toBeVisible();
  });
});
