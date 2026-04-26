/**
 * Per-fork database isolation for the vitest `integration` project.
 *
 * Without this, every fork connects to whatever DATABASE_URL points at
 * — typically the developer's `projekt_manager`. Each test's `startApp()`
 * then calls `seed(force: true)` which `TRUNCATE CASCADE`s users /
 * sessions / customers / projects. Two parallel runs (different
 * worktrees, different agents, dev session in another window) race each
 * other's TRUNCATE: one's reseed lands while the other is mid-test, so
 * `ownerToken` gets invalidated and subsequent requests return 401.
 *
 * The fix: each fork gets its own database, named after its PID. Runs
 * before any test imports so the per-PID DATABASE_URL is in place when
 * `startApp()` first calls `validateEnvRuntime()` (which re-parses process.env
 * on every call).
 *
 * Cleanup of dropped DBs lives in `integration-globalsetup.ts` — the
 * vitest `forks` pool exits workers via `process.exit()`, which skips
 * `beforeExit`, so a per-fork drop hook would unreliably leak.
 *
 * Symmetric with the e2e fix in `a24ef66` (`projekt_manager_e2e`), but
 * one-DB-per-process so multiple agents don't collide either.
 */

import pg from 'pg';

const TEST_DB_PREFIX = 'projekt_manager_test_';

const baseUrl =
  process.env.DATABASE_URL ?? 'postgresql://pm:changeme@localhost:5432/projekt_manager';
const adminUrl = (() => {
  const u = new URL(baseUrl);
  u.pathname = '/postgres';
  return u.toString();
})();
const dbName = `${TEST_DB_PREFIX}${process.pid}`;
const perProcessUrl = (() => {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    // 42P04 = duplicate_database. A stale PID-recycled DB is fine —
    // seed(force: true) in api-helpers wipes it on first startApp().
    if ((err as NodeJS.ErrnoException).code !== '42P04') throw err;
  }
} finally {
  await client.end();
}

process.env.DATABASE_URL = perProcessUrl;
