import { createDatabase } from '../../db/connection.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../../seed.js';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Database } from '../../db/connection.js';
import type pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../../db/migrations');

interface TestDb {
  db: Database;
  pool: pg.Pool;
}

/**
 * Sets up a test database connection with migrations and seed data.
 * Each test file gets a fresh seed (force: true).
 * Call teardownTestDb() in afterAll to properly close the pool.
 */
export async function setupTestDb(): Promise<TestDb> {
  const { db, pool } = createDatabase();
  // Verify the new pool is live and PG has released prior connections
  await pool.query('SELECT 1');
  await migrate(db, { migrationsFolder });
  await seed(db, { force: true });
  return { db, pool };
}

/**
 * Properly tears down the test database connection.
 * pool.end() drains all clients and resolves when connections are closed.
 */
export async function teardownTestDb(pool: pg.Pool): Promise<void> {
  await pool.end();
}
