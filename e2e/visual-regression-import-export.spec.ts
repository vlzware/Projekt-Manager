import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for import/export design ACs.
 *
 * Covers AC-86 through AC-90 ([vis] tier). Each test navigates to the
 * Import/Export view and captures a screenshot for baseline comparison.
 * No DOM assertions beyond waitFor — the screenshot IS the assertion.
 *
 * See CONTRIBUTING.md § Acceptance Criteria for the vis-AC policy.
 */

test.describe('Import UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();
    await page.getByTestId('view-toggle-daten').click();
    await page.getByTestId('import-export-view').waitFor();
  });

  test('AC-86 [vis]: import preview table', async ({ page }) => {
    await page.getByTestId('import-entity-select').selectOption('customers');

    const importData = JSON.stringify([
      { name: 'VR Kunde 1', phone: '0221-12345' },
      { name: 'VR Kunde 2', email: 'vr2@example.test' },
      { name: '' },
    ]);

    await page.getByTestId('import-file-input').setInputFiles({
      name: 'test-import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(importData),
    });

    const previewTable = page.getByTestId('import-preview-table');
    await previewTable.waitFor();
    await expect(previewTable).toHaveScreenshot('import-preview-table.png');
  });

  test('AC-87 [vis]: import result summary', async ({ page }) => {
    await page.getByTestId('import-entity-select').selectOption('customers');

    const importData = JSON.stringify([
      { name: 'VR Kunde 1', phone: '0221-12345' },
      { name: 'VR Kunde 2', email: 'vr2@example.test' },
      { name: '' },
    ]);

    await page.getByTestId('import-file-input').setInputFiles({
      name: 'test-import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(importData),
    });

    await page.getByTestId('import-preview-table').waitFor();
    await page.getByTestId('import-submit').click();

    const importResult = page.getByTestId('import-result');
    await importResult.waitFor();
    await expect(importResult).toHaveScreenshot('import-result-summary.png');
  });
});

test.describe('Export UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('kanban-board').waitFor();
    await page.getByTestId('view-toggle-daten').click();
    await page.getByTestId('import-export-view').waitFor();
  });

  test('AC-88 [vis]: export projects view', async ({ page }) => {
    await page.getByTestId('export-entity-select').selectOption('projects');
    await expect(page).toHaveScreenshot('export-projects-ui.png', { fullPage: true });
  });

  test('AC-89 [vis]: export customers view', async ({ page }) => {
    await page.getByTestId('export-entity-select').selectOption('customers');
    await expect(page).toHaveScreenshot('export-customers-ui.png', { fullPage: true });
  });
});

test.describe('Permission gating', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AC-90 [vis]: worker role sees disabled import controls', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-form').waitFor();
    await page.getByTestId('login-username').fill('arbeiter1');
    await page.getByTestId('login-password').fill('changeme');
    await page.getByTestId('login-submit').click();
    await page.getByTestId('kanban-board').waitFor();

    await page.getByTestId('view-toggle-daten').click();
    await page.getByTestId('import-export-view').waitFor();
    await expect(page).toHaveScreenshot('import-permissions-worker.png', { fullPage: true });
  });
});
