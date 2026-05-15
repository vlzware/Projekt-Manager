import { test as setup, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../src/server/db/connection.js';
import { seed } from '../src/server/seed.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../src/test/seedAssumptions.js';
import { STORAGE_STATES } from './storage-states';
import { resetE2eBucket } from './storage-reset';

/**
 * Auth setup — Playwright's shared-auth pattern, four roles.
 *
 * Logs in once per role (owner/office/worker/bookkeeper) and saves each
 * authenticated storage state to its own JSON file. Specs pick the role
 * they need via `test.use({ storageState: STORAGE_STATES.<role> })`.
 * Without this, per-test `loginAs` calls across the E2E specs burn
 * through the dev-mode login rate limit (30/min per IP,
 * `src/server/config/index.ts`) and the suite 429s itself around the
 * 30th login.
 *
 * The reseed (first setup test) runs before the logins so every run
 * starts from a known state. Playwright runs tests in a single file
 * serially, so the reseed → owner → office → worker → bookkeeper order
 * is preserved. The four login setups each use the `page` fixture,
 * which inherits the project's `use.baseURL`.
 *
 * The `.auth/` directory is gitignored — the JSON files contain session
 * tokens and are regenerated on every run.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_DIR = path.resolve(__dirname, '.auth');

try {
  process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
} catch {
  // .env missing — rely on existing environment.
}

/**
 * Log in as the given user and save the authenticated context. The
 * role-specific landing testid is the ready signal — see
 * `src/config/routes.ts` for the canonical per-role default:
 * owner/office → `/kanban` (`kanban-board`), worker → `/meine-projekte`
 * (`my-projects-view`), bookkeeper → `/rechnungen` (`invoice-list-view`).
 */
async function loginAndSaveState(
  page: Page,
  user: { username: string; displayName: string },
  landingTestId: 'kanban-board' | 'my-projects-view' | 'invoice-list-view',
  statePath: string,
): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-username').fill(user.username);
  await page.getByTestId('login-password').fill(SEED_DEFAULT_PASSWORD);
  await page.getByTestId('login-submit').click();

  // Playwright spawns a fresh vite + Fastify on every run (see
  // `reuseExistingServer: false` in playwright.config.ts), so the
  // first landing request pays vite's cold-start cost the first time
  // through. 15 s absorbs the worst case on a warm-ish cache; a cold
  // `.vite` directory can push this closer to 30 s, but we don't
  // optimise for the once-per-week case.
  await expect(page.getByTestId(landingTestId)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('user-indicator')).toContainText(user.displayName);

  await page.context().storageState({ path: statePath });

  // Chrome marks localhost cookies as Secure (localhost is a "secure
  // context"), but Playwright won't send Secure cookies over plain HTTP
  // when restoring state into a fresh context. Strip the flag so the
  // session cookie survives the handoff.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const cookie of state.cookies) cookie.secure = false;
  fs.writeFileSync(statePath, JSON.stringify(state));
}

setup('reseed database and storage', async () => {
  // Force-reseed so every Playwright run starts from a known state. The
  // TRUNCATE CASCADE invalidates any pre-existing sessions, which is
  // why this runs BEFORE the login setups below.
  //
  // Runs migrations first so a fresh E2E database (created on-demand
  // for the isolated `projekt_manager_e2e` target — see
  // playwright.config.ts webServer) gets its schema before the seed's
  // TRUNCATE reaches for tables that would not yet exist. Drizzle
  // tracks applied migrations, so this is a no-op on subsequent runs.
  const migrationsFolder = path.resolve(__dirname, '..', 'src/server/db/migrations');
  const { db, pool } = createDatabase();
  try {
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });
  } finally {
    await pool.end();
  }

  // Bucket reset is the storage-side counterpart of seed({ force: true }).
  // The seed truncates `attachments` (CASCADE from `projects`), so without
  // this the bucket from a prior run holds objects whose DB rows no
  // longer exist — DB-detached orphans the orphan reaper cannot reach
  // (it sweeps `pending` past TTL only). Targets the isolated e2e bucket
  // by playwright.config.ts override; refuses to run against the dev
  // bucket as a safety check.
  await resetE2eBucket();

  fs.mkdirSync(AUTH_DIR, { recursive: true });
});

setup('authenticate owner', async ({ page }) => {
  await loginAndSaveState(page, SEED_USERS.owner, 'kanban-board', STORAGE_STATES.owner);
});

setup('authenticate office', async ({ page }) => {
  await loginAndSaveState(page, SEED_USERS.office, 'kanban-board', STORAGE_STATES.office);
});

setup('authenticate worker', async ({ page }) => {
  // Worker landing is now `/meine-projekte` (the personal list view).
  await loginAndSaveState(page, SEED_USERS.worker1, 'my-projects-view', STORAGE_STATES.worker);
});

setup('authenticate bookkeeper', async ({ page }) => {
  await loginAndSaveState(page, SEED_USERS.bookkeeper, 'invoice-list-view', STORAGE_STATES.bookkeeper);
});
