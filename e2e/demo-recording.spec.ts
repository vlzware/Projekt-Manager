/**
 * Demo recording — produces a video of the LLM email extraction workflow.
 *
 * This is NOT a regular test. It hits the real extraction API and uses
 * deliberate pauses so the viewer can follow each step.
 *
 * Prerequisites:
 *   - Dev server running (`npm run dev`)
 *   - OPENROUTER_API_KEY configured in .env
 *   - Database seeded (`npm run db:seed` or prior E2E setup run)
 *
 * Run (headed, visible browser):
 *   npx playwright test e2e/demo-recording.spec.ts --project=demo --headed
 *
 * Output:
 *   test-results/<test-folder>/video.webm
 */
import { test, expect } from '@playwright/test';

/* Fresh session — no saved auth, so the recording starts at the login screen. */
test.use({ storageState: { cookies: [], origins: [] } });

/* LLM extraction can take a while; generous timeout for a demo. */
test.setTimeout(120_000);

/** Sample email #1 from src/test/fixtures/sample-emails.ts — all fields present. */
const SAMPLE_EMAIL = [
  'Sehr geehrte Damen und Herren,',
  '',
  'wir möchten Sie bitten, uns ein Angebot für die Renovierung unserer Büroräume zu erstellen.',
  'Es handelt sich um ca. 200 qm Bürofläche. Die Arbeiten umfassen Malerarbeiten (Wände und Decken)',
  'sowie die Erneuerung des Bodenbelags in drei Büroräumen.',
  '',
  'Mit freundlichen Grüßen,',
  'Hans Meier',
  'Geschäftsführer',
  'Meier & Partner Steuerberatung GmbH',
  'Tel: +49 2202 98765',
  'E-Mail: h.meier@meier-partner.de',
  'Hauptstraße 42',
  '51465 Bergisch Gladbach',
].join('\n');

test('LLM email extraction demo', async ({ page }) => {
  // toggled locally when recording the demo in a specific theme.
  await page.emulateMedia({ colorScheme: 'dark' });

  // ── Login screen ──────────────────────────────────────────────────
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  await page.waitForTimeout(1500);

  await page.getByTestId('login-username').pressSequentially('inhaber', { delay: 80 });
  await page.waitForTimeout(400);
  await page.getByTestId('login-password').pressSequentially('changeme', { delay: 80 });
  await page.waitForTimeout(600);

  await page.getByTestId('login-submit').click();

  // ── Dashboard ─────────────────────────────────────────────────────
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await page.waitForTimeout(2500);

  // ── Open extraction modal ─────────────────────────────────────────
  await page.getByTestId('extract-button').click();
  await expect(page.getByTestId('extract-email-input')).toBeVisible();
  await page.waitForTimeout(1000);

  // ── Paste email text ──────────────────────────────────────────────
  await page.getByTestId('extract-email-input').click();
  await page.waitForTimeout(300);
  await page.getByTestId('extract-email-input').fill(SAMPLE_EMAIL);
  await page.waitForTimeout(2000);

  // ── Extract ───────────────────────────────────────────────────────
  await page.getByTestId('extract-submit').click();

  // Wait for the LLM to respond — the modal transitions to the review
  // view once extraction succeeds. The customer-name field only appears
  // in the second stage, so its visibility signals completion.
  await expect(page.getByTestId('extract-customer-name')).toBeVisible({
    timeout: 60_000,
  });

  // Let the viewer see the populated fields.
  await page.waitForTimeout(5000);
});
