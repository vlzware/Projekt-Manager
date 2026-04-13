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
 * aggregate counts that break if another test inserts rows mid-run,
 * and the VR variants create prefixed data for screenshots.
 *
 * Read-only tests (failure-paths, insecure-banner, startup, base
 * visual-regression) run in parallel in a separate project that
 * completes before this one starts.
 */
const MUTATING_TESTS = /kanban-flows|management-flows|import-export-flows|visual-regression-management|visual-regression-import-export/;

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
      testIgnore: [/smoke\.spec\.ts/, /.*\.setup\.ts/, MUTATING_TESTS],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        storageState: STORAGE_STATE,
      },
    },

    // 3. Mutating tests — serial, single worker. Depends on setup only
    //    (not on chromium) so screenshot mismatches in read-only VR
    //    tests don't block functional test execution. Read-only tests
    //    can't contaminate mutating tests because they never write data.
    {
      name: 'chromium-mutating',
      dependencies: ['setup'],
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
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    env: {
      // E2E tests use fresh browser contexts with separate logins
      // (steps 23/24 deactivate/reactivate, VR worker-role tests).
      // The production limit of 5/min is too tight for the full suite.
      LOGIN_RATE_LIMIT_MAX: '30',
    },
  },
});
