/**
 * PushSubscriptionService unit tests — hardening pass, iteration 8.
 *
 * Pins the `prunePermanentlyDead` userId scoping fix: a subscription
 * belonging to user A must not be deleted when the caller supplies user
 * B's id. Previously the method deleted by id alone; the fix adds an
 * AND user_id = ? clause.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../db/connection.js';
import { validateEnvRuntime } from '../config/env.js';
import { seed } from '../seed.js';
import { PushSubscriptionService } from '../services/PushSubscriptionService.js';
import type { Database } from '../db/connection.js';
import type pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

let db: Database;
let pool: pg.Pool;
let service: PushSubscriptionService;

beforeAll(async () => {
  validateEnvRuntime();
  const conn = createDatabase();
  db = conn.db;
  pool = conn.pool;
  await pool.query('SELECT 1');
  await migrate(db, { migrationsFolder });
  await seed(db, { force: true });
  service = new PushSubscriptionService(db);
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('PushSubscriptionService.prunePermanentlyDead — userId scoping', () => {
  it('does not delete a subscription belonging to a different user', async () => {
    // Create two users via raw insert so the test is self-contained.
    const userARows = await db.execute<{ id: string }>(
      sql`INSERT INTO users (username, display_name, password_hash, roles)
          VALUES (${'prune_test_a_' + Date.now().toString(36)}, 'Prune A', 'x', '{}')
          RETURNING id`,
    );
    const userBRows = await db.execute<{ id: string }>(
      sql`INSERT INTO users (username, display_name, password_hash, roles)
          VALUES (${'prune_test_b_' + Date.now().toString(36)}, 'Prune B', 'x', '{}')
          RETURNING id`,
    );
    const userAId = (userARows.rows[0] as { id: string }).id;
    const userBId = (userBRows.rows[0] as { id: string }).id;

    // Subscribe user A.
    const sub = await service.subscribe(userAId, {
      endpoint: `https://push.example.com/prune-scope-${Date.now().toString(36)}`,
      keys: { p256dh: 'deadkey', auth: 'deadauth' },
    });

    // Call prunePermanentlyDead with user B's id — must not delete user A's row.
    await service.prunePermanentlyDead(userBId, sub.id);

    const countA = await service.countForUser(userAId);
    expect(countA).toBe(1); // Row must still exist.
  });

  it('deletes the subscription when userId matches', async () => {
    const userRows = await db.execute<{ id: string }>(
      sql`INSERT INTO users (username, display_name, password_hash, roles)
          VALUES (${'prune_test_own_' + Date.now().toString(36)}, 'Prune Own', 'x', '{}')
          RETURNING id`,
    );
    const userId = (userRows.rows[0] as { id: string }).id;

    const sub = await service.subscribe(userId, {
      endpoint: `https://push.example.com/prune-own-${Date.now().toString(36)}`,
      keys: { p256dh: 'deadkey2', auth: 'deadauth2' },
    });

    await service.prunePermanentlyDead(userId, sub.id);

    const count = await service.countForUser(userId);
    expect(count).toBe(0);
  });
});
