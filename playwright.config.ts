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

/**
 * Tests that create persistent data in the shared database.
 *
 * These must run serially (single worker) to prevent cross-test
 * contamination: management-flows creates customers/projects/users,
 * import-export-flows imports records, kanban-flows asserts on
 * aggregate counts that break if another test inserts rows mid-run.
 *
 * Read-only tests (failure-paths, insecure-banner, startup,
 * permission-visibility, theming) run in parallel in a separate project
 * that completes before this one starts.
 */
const MUTATING_TESTS = /kanban-flows|management-flows|import-export-flows|theme-preference/;
const DEMO_TESTS = /demo-.*\.spec\.ts/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    // Design ACs are verified by running Playwright in UI mode and reviewing
    // by eye (see CONTRIBUTING.md § Testing) — stored-screenshot baselines
    // were dropped as brittle friction. `retain-on-failure` captures a
    // full trace on any failing run so the failure can be inspected via
    // `npx playwright show-trace <zip>` without needing a retry to trigger.
    trace: 'retain-on-failure',
  },
  projects: [
    // 1. Setup — reseed database, authenticate once, save storage state.
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // 2. Read-only tests — safe to parallelize. These never INSERT
    //    rows, so they can't interfere with each other's assertions.
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: [/smoke\.spec\.ts/, /.*\.setup\.ts/, MUTATING_TESTS, DEMO_TESTS],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        storageState: STORAGE_STATE,
      },
    },

    // 3. Mutating tests — serial, single worker. Depends on chromium so
    //    read-only specs finish before mutations begin; prevents race
    //    conditions where a mutating test changes DB state while a
    //    read-only assertion is still evaluating.
    {
      name: 'chromium-mutating',
      dependencies: ['chromium'],
      testMatch: MUTATING_TESTS,
      fullyParallel: false,
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        storageState: STORAGE_STATE,
      },
    },

    // 4. Smoke test — unauthenticated login round-trip. Runs after
    //    mutating tests so user deactivation/reactivation has settled.
    {
      name: 'smoke',
      dependencies: ['chromium-mutating'],
      testMatch: /smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // 5. Demo recordings — not part of the normal test suite.
    //    Run: npx playwright test --project=demo --headed
    {
      name: 'demo',
      testMatch: DEMO_TESTS,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1400, height: 1200 },
        video: { mode: 'on', size: { width: 1400, height: 1200 } },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    env: {
      // E2E tests use fresh browser contexts with separate logins (steps
      // 23/24 deactivate/reactivate, permission-visibility per-role logins).
      // The production limit of 5/min is too tight for the full suite.
      LOGIN_RATE_LIMIT_MAX: '30',
    },
  },
});
