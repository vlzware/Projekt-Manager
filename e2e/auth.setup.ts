import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/server/db/connection.js';
import { seed } from '../src/server/seed.js';

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
 * This setup ALSO force-reseeds the database before logging in.
 * Without the reseed, mutation tests (state transitions, date edits)
 * accumulate residue across runs — a second `npx playwright test`
 * against the same dev server would see stale dates from the first
 * run and fail on assertions that compare to seed-derived values.
 * Reseeding here guarantees every Playwright invocation starts from
 * the same deterministic state.
 *
 * The resulting `.auth/user.json` is gitignored — it contains a
 * session token and is regenerated on every test run.
 */

// ESM module — derive __dirname from import.meta.url (see the
// matching comment in playwright.config.ts).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const STORAGE_STATE = path.resolve(__dirname, '.auth/user.json');

// Load .env so DATABASE_URL is available in Playwright's own process
// (separate from the dev server child process, which loads .env via
// `tsx --env-file=.env`). Node 20.12+ has a built-in env-file loader.
try {
  process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
} catch {
  // .env missing — rely on existing environment.
}

setup('reseed database and authenticate as inhaber', async ({ page }) => {
  // Force-reseed so every Playwright run starts from a known state.
  // TRUNCATE CASCADE invalidates any pre-existing sessions, which is
  // why this runs BEFORE the login below — the dev server's in-memory
  // state is rebuilt on the next query, so the login that follows
  // sees the fresh seed user.
  const { db, pool } = createDatabase();
  try {
    await seed(db, { force: true });
  } finally {
    await pool.end();
  }

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
