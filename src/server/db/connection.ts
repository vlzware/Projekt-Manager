/**
 * Database connection — Drizzle ORM over node-postgres.
 *
 * Reads DATABASE_URL from environment. Exports a factory
 * function so tests can create isolated connections.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { validateEnv } from '../config/env.js';
import * as schema from './schema.js';

const { Pool } = pg;

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A transaction handle — the argument Drizzle passes to a
 * `db.transaction(tx => ...)` callback.
 */
export type TxHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A `Database` or a transaction handle. Repository READ functions accept
 * this — they are callable from top-level code (with `db`) and from
 * inside a transaction (with `tx`).
 */
export type TransactionalDatabase = Database | TxHandle;

/**
 * Transaction handle ONLY — **not** a plain `Database`. Repository WRITE
 * functions on audited tables accept this so the type system enforces
 * AC-179: a mutation can only be authored from inside a transaction,
 * i.e. from inside `mutate()` / `mutateInTx()` (ADR-0021). Attempting to
 * call a write with a plain `Database` fails `tsc` — the bypass the
 * static arch check can't reliably detect (the scan can't distinguish
 * `db.insert(...)` from `tx.insert(...)`).
 */
export type MutatingDatabase = TxHandle;

export interface ConnectionOptions {
  connectionString?: string;
}

/**
 * Create a Drizzle database instance backed by a pg Pool.
 *
 * In production, DATABASE_URL must be explicitly set — no fallback is allowed.
 * In dev/test the convenience fallback still works.
 */
export function createDatabase(opts: ConnectionOptions = {}): {
  db: Database;
  pool: pg.Pool;
} {
  // Route env reads through the validated singleton so there is a single
  // source of truth for NODE_ENV and friends (consolidation review C-3 /
  // ADR-0013). Previously this file did a direct
  // `process.env.NODE_ENV === 'production'` check, which drifted from the
  // rest of the server after commit 48cfdea consolidated app.ts on getEnv().
  //
  // validateEnv() is idempotent — it caches the first parsed result and
  // returns it on subsequent calls — so calling it defensively here is
  // safe whether or not start.ts already ran it. Integration tests that
  // call createDatabase() directly (db-constraints, bootstrap, rate-limit)
  // rely on this defensive call because they do not go through start.ts.
  const env = validateEnv();
  let connectionString = opts.connectionString ?? env.DATABASE_URL;

  if (!connectionString) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'DATABASE_URL must be set in production. ' +
          'Refusing to start with a fallback connection string.',
      );
    }
    // Dev/test convenience fallback. Unreachable today because the env
    // schema makes DATABASE_URL required, but kept as a defense-in-depth
    // net in case the schema is ever relaxed.
    connectionString = `postgresql://pm:${process.env.POSTGRES_PASSWORD ?? 'postgres'}@localhost:5432/projekt_manager_test`;
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  return { db, pool };
}
