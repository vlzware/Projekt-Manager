/**
 * Unit tests for the periodic session reaper (AC-132).
 *
 * Uses vitest fake timers. We do not exercise the real DB here —
 * integration/end-to-end timer behavior is impractical to test against
 * real wall-clock intervals without flakiness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/connection.js';
import { startSessionReaper } from '../session-reaper.js';

function makeLogger() {
  return {
    info: vi.fn<(msg: string) => void>(),
    error: vi.fn<(err: unknown, msg: string) => void>(),
  };
}

/**
 * Fake DB — the reaper calls `deleteExpiredSessions(db)` which runs
 * `db.delete(...).where(...).returning(...)`. This stub mimics that chain
 * and lets the test control the "deleted count".
 */
function fakeDb(deletedRows: unknown[] | (() => Promise<unknown[]> | unknown[])): Database {
  const returning = () =>
    typeof deletedRows === 'function' ? Promise.resolve(deletedRows()) : deletedRows;
  return {
    delete: () => ({ where: () => ({ returning }) }),
  } as unknown as Database;
}

describe('startSessionReaper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes the configured intervalMinutes through to the scheduler', async () => {
    const logger = makeLogger();
    const reaper = startSessionReaper({
      db: fakeDb([{ id: 'one' }]),
      intervalMinutes: 5,
      logger,
    });

    // Nothing should have run yet.
    expect(logger.info).not.toHaveBeenCalled();

    // Advance just under the interval — still no sweep.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(logger.info).not.toHaveBeenCalled();

    // Crossing the boundary fires exactly once.
    await vi.advanceTimersByTimeAsync(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]![0]).toContain('1 expired sessions');

    // Second interval fires again.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(logger.info).toHaveBeenCalledTimes(2);

    await reaper.stop();
  });

  it('suppresses the log line when zero rows were deleted', async () => {
    const logger = makeLogger();
    const reaper = startSessionReaper({
      db: fakeDb([]),
      intervalMinutes: 1,
      logger,
    });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(logger.info).not.toHaveBeenCalled();
    await reaper.stop();
  });

  it('swallows sweep errors and keeps firing on the next interval', async () => {
    const logger = makeLogger();
    let calls = 0;
    const reaper = startSessionReaper({
      db: fakeDb(() => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return [{ id: 'ok' }];
      }),
      intervalMinutes: 1,
      logger,
    });

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![1]).toBe('session_reaper_sweep_failed');
    expect(logger.info).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(logger.info).toHaveBeenCalledTimes(1);

    await reaper.stop();
  });

  it('stop() cancels further sweeps', async () => {
    const logger = makeLogger();
    const reaper = startSessionReaper({
      db: fakeDb([{ id: 'x' }]),
      intervalMinutes: 1,
      logger,
    });
    await reaper.stop();
    await vi.advanceTimersByTimeAsync(60 * 1000 * 10);
    expect(logger.info).not.toHaveBeenCalled();
  });

  // The graceful-shutdown path in start.ts awaits stop() before pool.end().
  // This test uses a controlled-defer mock: the sweep hangs on a pending
  // promise until we call `release()`. We trigger the interval, call stop(),
  // then observe that `stop()` does NOT resolve until the sweep resolves.
  it('stop() awaits an in-flight sweep before resolving', async () => {
    const logger = makeLogger();
    let releaseSweep!: () => void;
    const sweepBlocker = new Promise<unknown[]>((resolve) => {
      releaseSweep = () => resolve([{ id: 'drained' }]);
    });
    const reaper = startSessionReaper({
      db: fakeDb(() => sweepBlocker),
      intervalMinutes: 1,
      logger,
    });

    // Fire the interval so a sweep begins but never resolves yet.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(logger.info).not.toHaveBeenCalled();

    let stopSettled = false;
    const stopPromise = reaper.stop().then(() => {
      stopSettled = true;
    });
    // Yield the microtask queue — if stop() were sync or not awaiting the
    // sweep, `stopSettled` would already be true here.
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseSweep();
    await stopPromise;
    expect(stopSettled).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
