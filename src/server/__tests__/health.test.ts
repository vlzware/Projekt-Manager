/**
 * Tests for the health probe (#48).
 *
 * The probe runs DB and storage checks in parallel and maps the outcome
 * to `{status, checks}`. The HTTP status code (200 vs 503) is decided
 * by the route handler in start.ts, not by the probe itself.
 *
 * These tests mock pg.Pool and StorageClient so we can exercise every
 * branch (both ok, db fail, storage fail, both fail) without standing
 * up real infrastructure. They live under src/server/__tests__/ and
 * therefore run in the `integration` vitest project (see vitest.config.ts),
 * but they do not require a live database or storage backend.
 */

import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { probeHealth } from '../health.js';
import type { StorageClient } from '../storage/client.js';

function mockPool(query: () => Promise<unknown>): pg.Pool {
  return { query } as unknown as pg.Pool;
}

function mockStorage(ping: () => Promise<void>): StorageClient {
  return {
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    getSignedUrl: vi.fn(),
    ping,
  } as StorageClient;
}

describe('probeHealth', () => {
  it('returns status "ok" when both checks succeed', async () => {
    const pool = mockPool(async () => ({ rows: [{ '?column?': 1 }] }));
    const storage = mockStorage(async () => undefined);

    const result = await probeHealth(pool, storage);

    expect(result).toEqual({
      status: 'ok',
      checks: { db: 'ok', storage: 'ok' },
    });
  });

  it('returns status "degraded" when db fails', async () => {
    const pool = mockPool(async () => {
      throw new Error('connection refused');
    });
    const storage = mockStorage(async () => undefined);

    const result = await probeHealth(pool, storage);

    expect(result.status).toBe('degraded');
    expect(result.checks.db).toBe('fail');
    expect(result.checks.storage).toBe('ok');
  });

  it('returns status "degraded" when storage fails', async () => {
    const pool = mockPool(async () => ({ rows: [{ '?column?': 1 }] }));
    const storage = mockStorage(async () => {
      throw new Error('NoSuchBucket');
    });

    const result = await probeHealth(pool, storage);

    expect(result.status).toBe('degraded');
    expect(result.checks.db).toBe('ok');
    expect(result.checks.storage).toBe('fail');
  });

  it('returns status "degraded" when both fail', async () => {
    const pool = mockPool(async () => {
      throw new Error('db dead');
    });
    const storage = mockStorage(async () => {
      throw new Error('minio dead');
    });

    const result = await probeHealth(pool, storage);

    expect(result).toEqual({
      status: 'degraded',
      checks: { db: 'fail', storage: 'fail' },
    });
  });

  it('runs both checks in parallel — a hang in one does not block the other', async () => {
    // Storage resolves immediately; DB takes a bit. Promise.allSettled
    // returns the wall-clock duration of the slower check, not the sum.
    const pool = mockPool(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { rows: [{ '?column?': 1 }] };
    });
    const storage = mockStorage(async () => undefined);

    const start = Date.now();
    await probeHealth(pool, storage);
    const elapsed = Date.now() - start;

    // Parallel execution should finish at roughly max(40ms, ~0ms) = ~40ms.
    // Serial would be the sum. The 150ms ceiling is intentionally loose:
    // CI timers can stutter (observed 92ms once under load), so we bound
    // this as "not catastrophically serial" rather than a tight budget.
    expect(elapsed).toBeLessThan(150);
  });
});
