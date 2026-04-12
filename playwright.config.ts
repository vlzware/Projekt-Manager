import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This project is ESM (`"type": "module"` in package.json), so
// `__dirname` is not defined — derive it from `import.meta.url`
// before resolving paths.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Auth storage path — must match e2e/auth.setup.ts. Declared here as a
 * literal (not imported from the setup file) so projects can reference
 * it without pulling a .ts source file into the config's resolution.
 */
const STORAGE_STATE = path.resolve(__dirname, 'e2e/.auth/user.json');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    // 1. Setup project — runs first, logs in once, writes the shared
    //    storage state consumed by the "chromium" project below. It's
    //    scoped via testMatch so only auth.setup.ts runs here.
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // 2. Authenticated tests — reuses the storage state from `setup`.
    //    Covers kanban-flows, failure-paths, and the API-only startup
    //    test (the latter doesn't care about storageState but gains
    //    nothing from running without it either).
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: [/smoke\.spec\.ts/, /.*\.setup\.ts/],
      use: {
        ...devices['Desktop Chrome'],
        // Override the default 1280px viewport: the responsive collapse
        // tiers (spec ui.md §10) hide tier-2 columns (incl. Geplant) below
        // 1350px, which the E2E tests need open.
        viewport: { width: 1920, height: 1080 },
        storageState: STORAGE_STATE,
      },
    },

    // 3. Smoke test — intentionally unauthenticated. smoke.spec.ts
    //    exercises the login round-trip itself, so it must start from
    //    a clean logged-out state (no `storageState` in this project).
    //    BUT it must still depend on `setup` because setup reseeds the
    //    database: without the dependency, smoke would run in parallel
    //    with the TRUNCATE CASCADE in auth.setup.ts and race the user
    //    it tries to log in as.
    {
      name: 'smoke',
      dependencies: ['setup'],
      testMatch: /smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
