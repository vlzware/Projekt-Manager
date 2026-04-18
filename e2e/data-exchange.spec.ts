import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { EXPECTED_RESTORE_PHRASE } from '../src/test/seedAssumptions.js';

/**
 * E2E: unified Daten view (AC-142, AC-143, AC-144, AC-161).
 *
 * Written ahead of implementation. Until the new Daten view exists these
 * tests fail with missing-test-id errors. They define the implementation
 * target for selectors.
 *
 * testids introduced by this spec — the UI implementation must match:
 *
 *   view-toggle-daten              (already exists)
 *   daten-view                     outer container for the new view
 *   data-export-button             single "Herunterladen" trigger
 *   data-import-file-input         <input type="file"> for envelope upload
 *   data-import-preview            preview panel after dry-run completes
 *   data-import-preview-customers  count cell for customers
 *   data-import-preview-projects   count cell for projects
 *   data-import-preview-workers    count cell for project_workers
 *   data-import-phrase-input       confirmation-phrase input (non-empty target only, AC-161)
 *   data-import-commit             commit (real restore) button
 *   data-import-result             success summary panel
 *
 * Seed data assumptions inherited from e2e/auth.setup.ts:
 *   - 21 customers, 19 projects, 7 project_workers rows
 *   - User: inhaber (owner) authenticated via shared storageState
 *   - 5/30/min login rate limit handled by the shared-auth pattern
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Must match e2e/auth.setup.ts. Playwright forbids importing from a test
// setup file, so the path is duplicated — safe because both files resolve
// against the same directory.
const STORAGE_STATE = path.resolve(__dirname, '.auth/user.json');

test.describe.configure({ mode: 'serial' });

// AC-143 commits a destructive restore that replaces the seeded business
// data with a 1-customer / 1-project envelope. Subsequent mutating specs
// (kanban-flows, management-flows, theme-preference) rely on the original
// seed, so snapshot it before and restore it after via the export/import
// API. Using the API (not a direct-DB reseed) avoids invalidating the
// shared storageState cookie — /api/import only touches business data.
let preSpecSnapshot: unknown = null;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const res = await context.request.get('/api/export');
  if (res.ok()) {
    preSpecSnapshot = await res.json();
  }
  await context.close();
});

test.afterAll(async ({ browser }) => {
  if (!preSpecSnapshot) return;
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  // AC-160: override into a non-empty DB requires the confirmation phrase
  // in the request body. The teardown passes it so the seed-restore runs.
  const snapshot = preSpecSnapshot as Record<string, unknown>;
  await context.request.post('/api/import?override=true', {
    data: { ...snapshot, confirmation_phrase: EXPECTED_RESTORE_PHRASE },
  });
  await context.close();
});

async function loginAs(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill('changeme');
  await page.getByTestId('login-submit').click();
  // Wait for the authenticated layout — `header` mounts on every role's
  // landing view. The previous wait on `kanban-board` hung for bookkeeper,
  // whose landing is `/projects` per the central route table.
  await page.getByTestId('header').waitFor();
}

// ---------------------------------------------------------------
// AC-142: Daten tab visibility follows data:export permission
// ---------------------------------------------------------------
test.describe('AC-142: Daten tab permission visibility', () => {
  // Each role logs in fresh — override the shared storageState.
  test.use({ storageState: { cookies: [], origins: [] } });

  // AC-142: owner holds data:export → tab visible
  test('owner sees the Daten tab', async ({ page }) => {
    await loginAs(page, 'inhaber');
    await expect(page.getByTestId('view-toggle-daten')).toHaveCount(1);
  });

  // AC-142: office holds data:export → tab visible
  test('office sees the Daten tab', async ({ page }) => {
    await loginAs(page, 'buero');
    await expect(page.getByTestId('view-toggle-daten')).toHaveCount(1);
  });

  // AC-142: worker lacks data:export → tab hidden
  test('worker does NOT see the Daten tab', async ({ page }) => {
    await loginAs(page, 'arbeiter1');
    await expect(page.getByTestId('view-toggle-daten')).toHaveCount(0);
  });

  // AC-142: bookkeeper lacks data:export → tab hidden
  test('bookkeeper does NOT see the Daten tab', async ({ page }) => {
    await loginAs(page, 'buchhalter');
    await expect(page.getByTestId('view-toggle-daten')).toHaveCount(0);
  });
});

// Shared minimal self-consistent envelope for the restore-flow specs.
// Content is intentionally trivial — the two tests below pin UI behavior,
// not envelope shape (that's covered in the API-integration suite).
function buildRestoreEnvelope() {
  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    customers: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        name: 'E2E Import Kunde',
        phone: null,
        email: null,
        address: null,
        notes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    projects: [
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000001',
        number: '2026-E2E',
        title: 'E2E Import Projekt',
        status: 'anfrage',
        statusChangedAt: '2026-01-02T00:00:00.000Z',
        customerId: 'aaaaaaaa-0000-4000-8000-000000000001',
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: false,
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    project_workers: [],
  };
}

// ---------------------------------------------------------------
// AC-143: dry-run preview renders before commit
// ---------------------------------------------------------------
test.describe('AC-143: restore preview renders before commit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  // AC-143: selecting an envelope file triggers the dry-run and the
  // preview appears with per-entity counts. The test stops at the preview
  // — commit-gate behavior on non-empty target is pinned by AC-161 below.
  test('dry-run preview renders per-entity counts on upload', async ({ page }) => {
    await page.getByTestId('view-toggle-daten').click();
    await expect(page.getByTestId('daten-view')).toBeVisible();

    const envelope = buildRestoreEnvelope();
    const fixturePath = path.join(__dirname, '.tmp-data-exchange-preview.json');
    fs.writeFileSync(fixturePath, JSON.stringify(envelope, null, 2));

    try {
      await page.getByTestId('data-import-file-input').setInputFiles(fixturePath);
      await expect(page.getByTestId('data-import-preview')).toBeVisible();
      await expect(page.getByTestId('data-import-preview-customers')).toContainText('1');
      await expect(page.getByTestId('data-import-preview-projects')).toContainText('1');
      await expect(page.getByTestId('data-import-preview-workers')).toContainText('0');
    } finally {
      if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
    }
  });
});

// ---------------------------------------------------------------
// AC-161: restore phrase gate on non-empty target
// ---------------------------------------------------------------
test.describe('AC-161: restore phrase gate on non-empty target', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  // AC-161: seeded DB → preview reports target_non_empty → the phrase
  // input appears and the commit stays disabled until the typed value
  // matches the configured phrase. The click dispatches the request and
  // a success panel appears, pinning the end-to-end flow.
  test('phrase input gates commit on non-empty target', async ({ page }) => {
    await page.getByTestId('view-toggle-daten').click();
    await expect(page.getByTestId('daten-view')).toBeVisible();

    const envelope = buildRestoreEnvelope();
    const fixturePath = path.join(__dirname, '.tmp-data-exchange-phrase.json');
    fs.writeFileSync(fixturePath, JSON.stringify(envelope, null, 2));

    try {
      await page.getByTestId('data-import-file-input').setInputFiles(fixturePath);
      await expect(page.getByTestId('data-import-preview')).toBeVisible();

      // Phrase input renders only on non-empty target (true here).
      const phraseInput = page.getByTestId('data-import-phrase-input');
      await expect(phraseInput).toBeVisible();

      // Commit is disabled until the phrase matches.
      const commit = page.getByTestId('data-import-commit');
      await expect(commit).toBeDisabled();

      // A non-matching phrase must not enable commit.
      await phraseInput.fill('FALSCH');
      await expect(commit).toBeDisabled();

      // The configured phrase enables commit; clicking dispatches a
      // successful atomic wipe+restore (server re-validates the phrase).
      await phraseInput.fill(EXPECTED_RESTORE_PHRASE);
      await expect(commit).toBeEnabled();
      await commit.click();
      await expect(page.getByTestId('data-import-result')).toBeVisible();
    } finally {
      if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
    }
  });
});

// ---------------------------------------------------------------
// AC-144: single "Herunterladen" action + timestamped filename
// ---------------------------------------------------------------
test.describe('AC-144: unified export download', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  // AC-144: single button triggers download; filename contains "export"
  // and a timestamp; content parses as JSON envelope with the required keys.
  test('Herunterladen action downloads a timestamped JSON envelope', async ({ page }) => {
    await page.getByTestId('view-toggle-daten').click();
    await expect(page.getByTestId('daten-view')).toBeVisible();

    // Exactly one export action — not per-entity controls.
    const exportButton = page.getByTestId('data-export-button');
    await expect(exportButton).toHaveCount(1);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportButton.click(),
    ]);

    // AC-144: filename includes "export" + a timestamp cue. Spec example:
    //   projekt-manager-export-2026-04-15T14-23-07.json
    // The regex pins date + time without locking the exact format.
    const filename = download.suggestedFilename();
    expect(filename).toContain('export');
    expect(filename).toMatch(/\d{4}-\d{2}-\d{2}/); // date
    expect(filename).toMatch(/\d{2}[:-]\d{2}[:-]\d{2}/); // time
    expect(filename.endsWith('.json')).toBe(true);

    // Parse and check the envelope keys.
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const raw = fs.readFileSync(downloadPath!, 'utf-8');
    const envelope = JSON.parse(raw);

    expect(typeof envelope.schema_version).toBe('number');
    expect(Array.isArray(envelope.customers)).toBe(true);
    expect(Array.isArray(envelope.projects)).toBe(true);
    expect(Array.isArray(envelope.project_workers)).toBe(true);
  });
});
