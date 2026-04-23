/**
 * Ensure the E2E Postgres database exists before `npm run dev:e2e`
 * spawns vite + fastify. If the target DB is missing, fastify's first
 * `migrate()` call fails with `database "projekt_manager_e2e" does not
 * exist` and Playwright then times out on `/api/health` with no useful
 * signal about what went wrong.
 *
 * Cannot live in Playwright's `globalSetup`: that hook runs AFTER the
 * webServer's readiness probe succeeds, so it cannot bootstrap the DB
 * the webServer needs to start. Prepending this step to the `dev:e2e`
 * npm script is the earliest point where DATABASE_URL is available and
 * the server process has not yet been spawned.
 *
 * Uses a maintenance connection to the default `postgres` database
 * (which always exists) to issue CREATE DATABASE — a schema-aware pool
 * aimed at the target would fail because the target is what we are
 * about to create. Requires the connecting role (`pm` in every local
 * and CI topology) to have CREATEDB, which it does.
 */

import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ensure-db: DATABASE_URL is not set');
  process.exit(1);
}

const parsed = new URL(url);
const targetDb = parsed.pathname.replace(/^\//, '');
if (!targetDb) {
  console.error(`ensure-db: DATABASE_URL has no database name (${url})`);
  process.exit(1);
}

const admin = new URL(url);
admin.pathname = '/postgres';

const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
try {
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
  if (existing.rows.length > 0) {
    process.exit(0);
  }
  // CREATE DATABASE does not accept a parameter placeholder for the
  // database name, so the identifier has to be interpolated. The value
  // comes from DATABASE_URL which we own, not from user input, so
  // injection is not a risk — but double-quoting (with any literal `"`
  // doubled) keeps the call safe against unusual names.
  const quoted = '"' + targetDb.replace(/"/g, '""') + '"';
  await client.query(`CREATE DATABASE ${quoted}`);
  console.log(`ensure-db: created database "${targetDb}"`);
} finally {
  await client.end();
}
