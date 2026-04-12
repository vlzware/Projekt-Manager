import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

/**
 * E2E Import/Export flows
 *
 * Covers §16.4 steps 25–27: customer import with partial success,
 * project export (all + filtered).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the expected end-to-end behavior for the import/export view introduced
 * in iteration 6.
 *
 * Seed data assumptions (inherited from auth.setup.ts):
 *   - User: inhaber / changeme (Thomas Berger, owner)
 *   - 15–20 seeded projects across 9 states
 *   - 3 seeded projects in rechnung_faellig
 *
 * Test IDs follow the established naming convention.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe.configure({ mode: 'serial' });

test.describe('Import/Export flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Step 25: Customer import with partial success
  // AC-70, AC-86, AC-87
  // ---------------------------------------------------------------
  test('step 25: import customers — 2 valid, 1 invalid', async ({ page }) => {
    // Navigate to the Import/Export view
    await page.getByTestId('view-toggle-daten').click();
    await expect(page.getByTestId('import-export-view')).toBeVisible();

    // Select "Kunden" as the entity type for import
    await page.getByTestId('import-entity-select').selectOption('customers');

    // Prepare a JSON file with 3 customer records (1 invalid — missing name)
    const importData = [
      { name: 'Import Kunde Eins', phone: '0221-1111' },
      { phone: '0221-2222' }, // Invalid — missing required name field
      { name: 'Import Kunde Drei', email: 'drei@example.de' },
    ];

    const importFilePath = path.join(__dirname, '.tmp-import-test.json');
    fs.writeFileSync(importFilePath, JSON.stringify(importData, null, 2));

    try {
      // Upload the JSON file
      const fileInput = page.getByTestId('import-file-input');
      await fileInput.setInputFiles(importFilePath);

      // AC-86: Preview table should appear with parsed records
      const previewTable = page.getByTestId('import-preview-table');
      await expect(previewTable).toBeVisible();

      // The preview should show 3 rows
      const previewRows = previewTable.locator('tbody tr');
      await expect(previewRows).toHaveCount(3);

      // Submit the import
      await page.getByTestId('import-submit').click();

      // AC-87: Result summary shows imported count and error rows
      const importResult = page.getByTestId('import-result');
      await expect(importResult).toBeVisible();

      // 2 imported, 1 error
      await expect(importResult).toContainText('2');

      // Error row should indicate the index (1) and a German message
      const errorRow = page.getByTestId('import-error-row-1');
      await expect(errorRow).toBeVisible();
      await expect(errorRow).toContainText('1'); // Row index
    } finally {
      // Clean up the temporary file
      if (fs.existsSync(importFilePath)) {
        fs.unlinkSync(importFilePath);
      }
    }
  });

  // ---------------------------------------------------------------
  // Step 26: Export all projects as JSON
  // AC-71, AC-88
  // ---------------------------------------------------------------
  test('step 26: export all projects as JSON file', async ({ page }) => {
    // Navigate to the Import/Export view
    await page.getByTestId('view-toggle-daten').click();
    await expect(page.getByTestId('import-export-view')).toBeVisible();

    // Select "Projekte" as the entity type for export
    await page.getByTestId('export-entity-select').selectOption('projects');

    // Trigger export and capture the download
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-button').click(),
    ]);

    // Verify the downloaded file
    const filename = download.suggestedFilename();
    expect(filename).toContain('projekte');
    expect(filename).toContain('.json');

    // Read and parse the file contents
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const content = fs.readFileSync(downloadPath!, 'utf-8');
    const projects = JSON.parse(content);

    // All non-deleted projects should be in the export
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThanOrEqual(15); // Seed has 15-20

    // Verify shape: each project has required fields
    for (const project of projects) {
      expect(project.id).toBeDefined();
      expect(project.number).toBeDefined();
      expect(project.title).toBeDefined();
      expect(project.status).toBeDefined();
    }

    // No soft-deleted projects in export
    for (const project of projects) {
      expect(project.deleted).not.toBe(true);
    }
  });

  // ---------------------------------------------------------------
  // Step 27: Export projects filtered by status
  // AC-71, AC-88
  // ---------------------------------------------------------------
  test('step 27: export projects filtered by status', async ({ page }) => {
    // Navigate to the Import/Export view
    await page.getByTestId('view-toggle-daten').click();
    await expect(page.getByTestId('import-export-view')).toBeVisible();

    // Select "Projekte" for export
    await page.getByTestId('export-entity-select').selectOption('projects');

    // Apply a status filter — rechnung_faellig (seed has 3)
    await page.getByTestId('export-status-filter').selectOption('rechnung_faellig');

    // Trigger export and capture the download
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-button').click(),
    ]);

    // Read and verify the contents
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const content = fs.readFileSync(downloadPath!, 'utf-8');
    const projects = JSON.parse(content);

    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBe(3); // Seed has exactly 3 rechnung_faellig

    // All projects must match the filter
    for (const project of projects) {
      expect(project.status).toBe('rechnung_faellig');
    }
  });
});
