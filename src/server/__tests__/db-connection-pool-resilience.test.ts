/**
 * Pool-error resilience contract for `createDatabase()`.
 *
 * Pins the requirement that every pg.Pool returned by `createDatabase`
 * has an 'error' listener attached, and that an idle-client error does
 * NOT crash the host process. This is the canonical node-postgres
 * footgun (their docs: "If no listeners are bound to the 'error' event
 * then the error will be uncaught and your application will crash.")
 * and it bit the VPS during scripts/sync-dev-to-vps.sh: the script's
 * pg_terminate_backend on the app's idle pool clients propagated an
 * unhandled error → process exit → container restart → tmpfs binary
 * identity wiped (ADR-0024) → boot probe blocked on operator paste.
 *
 * The synthetic test (emit 'error' directly) pins the listener
 * contract. The realistic test (run pg_terminate_backend through a
 * second connection and observe the pool absorbing the error)
 * re-creates the actual incident shape.
 */

import { describe, it, expect, afterEach } from 'vitest';
import pg from 'pg';

import { createDatabase } from '../db/connection.js';

const closables: pg.Pool[] = [];

afterEach(async () => {
  while (closables.length > 0) {
    const pool = closables.pop()!;
    await pool.end().catch(() => {
      /* best effort */
    });
  }
});

describe('createDatabase pool error supervision', () => {
  it('attaches an error listener so a synthetic pool error is absorbed', () => {
    const { pool } = createDatabase();
    closables.push(pool);

    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    // Without a listener, EventEmitter#emit('error', …) throws synchronously.
    // The handler turns it into a no-op log line — the assertion below pins
    // that contract (`emit` returns true when at least one listener fired).
    const handled = pool.emit('error', new Error('synthetic-pool-error'));
    expect(handled).toBe(true);
  });

  it('survives pg_terminate_backend on idle pool clients', async () => {
    const { pool } = createDatabase();
    closables.push(pool);

    // Establish a backend so there's a PID to terminate. The client is
    // released so it sits idle in the pool — same shape as the app's
    // idle connections that sync-restore-vps.sh kills.
    const client = await pool.connect();
    let targetPid: number;
    try {
      const res = await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid');
      targetPid = res.rows[0].pid;
    } finally {
      client.release();
    }

    // Kill the backend from a separate, ad-hoc connection so the
    // terminate doesn't self-cancel.
    const killer = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    closables.push(killer);
    await killer.query('SELECT pg_terminate_backend($1)', [targetPid]);

    // Two contract claims to pin:
    //
    //   (1) The vitest worker is still alive after the kill. Without
    //       attachPoolErrorHandler, the pool's 'error' event would be
    //       unhandled, EventEmitter would throw synchronously, and the
    //       fork would exit before we reach this line.
    //
    //   (2) The pool eventually serves a healthy query. node-postgres
    //       removes the dead client from the pool on its socket-error
    //       handler; the next checkout creates a fresh backend. The
    //       FIRST query after the kill may itself race that removal
    //       and surface "terminating connection due to administrator
    //       command" — that's a recoverable rejection, not a crash.
    //       Retry a small number of times to ride out the race.
    let lastErr: unknown = null;
    let after: { rows: { ok: number }[] } | null = null;
    for (let i = 0; i < 5; i++) {
      try {
        after = await pool.query<{ ok: number }>('SELECT 1::int AS ok');
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(lastErr).toBeNull();
    expect(after?.rows[0].ok).toBe(1);
  });
});
