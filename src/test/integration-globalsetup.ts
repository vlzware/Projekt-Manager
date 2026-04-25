/**
 * Sweep orphaned `projekt_manager_test_<pid>` databases before and
 * after the integration suite. "Orphan" = the PID encoded in the name
 * is no longer alive. Active runs from other agents/worktrees survive.
 *
 * Runs in the main vitest process (forks/workers have not been spawned
 * yet at setup time and have already exited by teardown time), so it
 * cannot create the per-fork DB itself — that lives in
 * `integration-setup.ts`. The teardown side is what reliably reaps this
 * run's forks: vitest's `forks` pool exits each worker via
 * `process.exit()`, which skips `beforeExit`, so a per-fork drop hook
 * is not viable.
 */

import pg from 'pg';

const TEST_DB_PREFIX = 'projekt_manager_test_';

function adminConnectionString(): string {
  const baseUrl =
    process.env.DATABASE_URL ?? 'postgresql://pm:changeme@localhost:5432/projekt_manager';
  const u = new URL(baseUrl);
  u.pathname = '/postgres';
  return u.toString();
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but owned by another user — leave it alone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function sweepOrphans(): Promise<void> {
  const client = new pg.Client({ connectionString: adminConnectionString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${TEST_DB_PREFIX}%`],
    );
    for (const { datname } of rows) {
      const pid = Number.parseInt(datname.slice(TEST_DB_PREFIX.length), 10);
      if (isPidAlive(pid)) continue;
      try {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [datname],
        );
        await client.query(`DROP DATABASE IF EXISTS "${datname}"`);
      } catch {
        // Best-effort. Another concurrent sweeper may have raced us.
      }
    }
  } finally {
    await client.end();
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  await sweepOrphans();
  return async () => {
    await sweepOrphans();
  };
}
