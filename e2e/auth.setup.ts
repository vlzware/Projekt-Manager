import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Auth setup — Playwright's recommended shared-auth pattern.
 *
 * A dedicated "setup" project logs in once, saves the authenticated
 * storage state (cookies + localStorage) to a JSON file, and every
 * other project consumes it via `use.storageState`. Without this,
 * each test's `beforeEach(login)` would burn through the server's
 * 5-per-minute login rate limit (src/server/config/index.ts:33) and
 * the suite would 429 itself starting around the 6th test.
 *
 * The resulting `.auth/user.json` is gitignored — it contains a
 * session token and is regenerated on every test run.
 */

// ESM module — derive __dirname from import.meta.url (see the
// matching comment in playwright.config.ts).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const STORAGE_STATE = path.resolve(__dirname, '.auth/user.json');

setup('authenticate as inhaber', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('login-username').fill('inhaber');
  await page.getByTestId('login-password').fill('changeme');
  await page.getByTestId('login-submit').click();

  // Wait for the authenticated state to be fully committed before
  // saving — otherwise the cookie may not yet be set in the context.
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await expect(page.getByTestId('user-indicator')).toContainText('Thomas Berger');

  await page.context().storageState({ path: STORAGE_STATE });
});
