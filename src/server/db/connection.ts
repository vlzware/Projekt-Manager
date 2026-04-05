/**
 * Database connection — Drizzle ORM over node-postgres.
 *
 * Reads DATABASE_URL from environment. Exports a factory
 * function so tests can create isolated connections.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface ConnectionOptions {
  connectionString?: string;
}

/**
 * Create a Drizzle database instance backed by a pg Pool.
 */
export function createDatabase(opts: ConnectionOptions = {}): {
  db: Database;
  pool: pg.Pool;
} {
  const connectionString =
    opts.connectionString ??
    process.env.DATABASE_URL ??
    `postgresql://pm:${process.env.POSTGRES_PASSWORD ?? 'postgres'}@localhost:5432/projekt_manager_test`;

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  return { db, pool };
}
