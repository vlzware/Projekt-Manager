/**
 * API integration tests — bulk-download temp-zip reaper.
 *
 * Sibling of `attachments-reaper.test.ts` (AC-213). The bulk-download
 * reaper sweeps storage-only ephemera under `bulk-downloads/<uuid>.zip`
 * that have no DB row, so the assertions pivot on storage-side
 * `LastModified` instead of DB `created_at`. See
 * `src/server/services/bulk-download-reaper.ts` for the contract under
 * test.
 *
 * Coverage pinned by this file:
 *   - TTL boundary: an object older than the TTL is deleted; one
 *     inside the TTL window is retained. Both arms asserted with the
 *     same seed so a single upload drives both checks.
 *   - Prefix scoping: objects outside `bulk-downloads/` (e.g. a stale
 *     `attachments/...` key) are untouched — defence against the
 *     reaper drifting into the orphan-reaper's territory.
 *   - No-op run: zero expired objects still emits exactly one info log
 *     line with `removed_count: 0` and the full operational-log field
 *     set.
 *   - Operational-log shape: successful sweep emits one info line with
 *     `event = 'bulk-download-reaper'`, `ttl_minutes`, `removed_count`,
 *     `ran_at` (ISO 8601). Same field set as the orphan reaper; own
 *     event name so operators can split the two streams.
 *   - Partial failure: a `hide` throw does not abort the sweep;
 *     the reaper logs the failure with `error_hint` and continues with
 *     the remaining stale keys.
 *
 * Clock injection: the reaper accepts `now?: Date`. Instead of
 * backdating `LastModified` on the server (MinIO does not permit that
 * and real-time sleeps would be flaky), each test uploads and then
 * passes a `now` value offset from the client-side upload moment —
 * turning the cutoff window forwards or backwards to the side we want
 * to test. `ttlMinutes = 1` is used so the second-resolution of
 * `LastModified` is comfortably below the test-chosen margin (> 5s).
 *
 * Scheduler drain (`stop()` awaits an in-flight sweep) is covered in a
 * separate `describe` block using fake timers + a stub storage, mirror-
 * ing `audit-retention-scheduler.test.ts`. That keeps the drain
 * assertion deterministic without real timers against MinIO.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageClient } from '../storage/client.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { getEnv, validateEnvRuntime } from '../config/env.js';
import {
  EVENT_BULK_DOWNLOAD_REAPER,
  runBulkDownloadReaper,
} from '../services/bulk-download-reaper.js';
import { BULK_DOWNLOAD_PREFIX } from '../services/BulkDownloadOrchestrator.js';
import { startBulkDownloadReaperScheduler } from '../bulk-download-reaper-scheduler.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** Remove every object under `bulk-downloads/` so each test starts clean. */
async function purgeBulkDownloadPrefix(storage: AttachmentStorageClient): Promise<void> {
  const keys = await storage.listObjects(BULK_DOWNLOAD_PREFIX);
  await Promise.all(keys.map((k) => storage.hide(k)));
}

/**
 * Upload a dummy bulk-download zip and return its key + the client-side
 * moment of upload. Tests use this moment — not the server's
 * `LastModified` — to compute the `now` injected into the reaper; a
 * large (> 5s) offset is chosen so any skew between client and server
 * clocks stays well inside the margin.
 */
async function seedBulkDownloadZip(
  storage: AttachmentStorageClient,
  id: string,
): Promise<{ key: string; uploadedAt: Date }> {
  const key = `${BULK_DOWNLOAD_PREFIX}${id}.zip`;
  const uploadedAt = new Date();
  await storage.putObject(key, Buffer.from(`bulk-zip-${id}`), 'application/zip');
  return { key, uploadedAt };
}

/** Probe object existence via `headObject`. */
async function objectAbsent(storage: AttachmentStorageClient, key: string): Promise<boolean> {
  try {
    await storage.headObject(key);
    return false;
  } catch {
    return true;
  }
}

describe('Bulk-download temp-zip reaper', () => {
  let storage: AttachmentStorageClient;

  beforeAll(() => {
    validateEnvRuntime();
    const env = getEnv();
    storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
    });
  });

  beforeEach(async () => {
    await purgeBulkDownloadPrefix(storage);
  });

  afterAll(async () => {
    // Leave the bucket clean for the next run.
    await purgeBulkDownloadPrefix(storage);
  });

  // -------------------------------------------------------------------
  // TTL boundary — one seed, both arms.
  //
  // Object uploaded at `uploadedAt`. With `ttlMinutes = 1`, cutoff =
  // now - 60s. We drive `now` to either side of the 60s threshold.
  // -------------------------------------------------------------------
  it('removes an object older than TTL and leaves one inside the window (TTL ± boundary)', async () => {
    const { key, uploadedAt } = await seedBulkDownloadZip(storage, 'boundary-expired');
    const ttlMinutes = 1;

    // Fresh arm: now = uploadedAt + 55s. Cutoff = now - 60s = uploadedAt
    // - 5s, which precedes the upload → object retained.
    await runBulkDownloadReaper({
      storage,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now: new Date(uploadedAt.getTime() + 55 * SECOND_MS),
    });
    expect(await objectAbsent(storage, key)).toBe(false);

    // Expired arm: now = uploadedAt + 70s. Cutoff = now - 60s =
    // uploadedAt + 10s, well past the upload → object removed.
    await runBulkDownloadReaper({
      storage,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now: new Date(uploadedAt.getTime() + 70 * SECOND_MS),
    });
    expect(await objectAbsent(storage, key)).toBe(true);
  });

  // -------------------------------------------------------------------
  // Prefix scoping — an ancient `attachments/...` key must not be
  // touched even when the reaper's `now` is far in the future.
  // -------------------------------------------------------------------
  it('touches only keys under bulk-downloads/, leaving attachments/ keys alone', async () => {
    // Seed one bulk-download zip (expired target).
    const expired = await seedBulkDownloadZip(storage, 'prefix-scope-expired');

    // Seed an `attachments/...` key. The orphan reaper would own this,
    // not us — the bulk-download reaper must not notice it exists.
    const foreignKey = `attachments/prefix-scope/${crypto.randomUUID()}.orig`;
    await storage.putObject(foreignKey, Buffer.from('not-yours'), 'application/octet-stream');

    const ttlMinutes = 1;
    // `now` far in the future makes everything "old" on paper; only the
    // prefix filter is between the reaper and the foreign key.
    const now = new Date(expired.uploadedAt.getTime() + 60 * MINUTE_MS);

    await runBulkDownloadReaper({
      storage,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now,
    });

    expect(await objectAbsent(storage, expired.key)).toBe(true);
    expect(await objectAbsent(storage, foreignKey)).toBe(false);

    // Housekeeping — leave no foreign key behind.
    await storage.hide(foreignKey);
  });

  // -------------------------------------------------------------------
  // No-op run — empty prefix. Still exactly one info line, count = 0,
  // full operational-log shape.
  // -------------------------------------------------------------------
  it('emits one info line with removed_count=0 on a no-op run (empty prefix)', async () => {
    const info = vi.fn();
    const error = vi.fn();
    const ttlMinutes = 1;
    const now = new Date();

    await runBulkDownloadReaper({
      storage,
      logger: { info, error },
      ttlMinutes,
      now,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    const [context, eventName] = info.mock.calls[0]!;
    expect(eventName).toBe(EVENT_BULK_DOWNLOAD_REAPER);
    const ctx = context as Record<string, unknown>;
    expect(ctx.event).toBe(EVENT_BULK_DOWNLOAD_REAPER);
    expect(ctx.ttl_minutes).toBe(ttlMinutes);
    expect(ctx.removed_count).toBe(0);
    expect(typeof ctx.ran_at).toBe('string');
    expect(Number.isNaN(Date.parse(ctx.ran_at as string))).toBe(false);
  });

  // -------------------------------------------------------------------
  // Operational-log shape on a productive sweep — mirror of the orphan
  // reaper's AC-213 shape, own event name.
  // -------------------------------------------------------------------
  it('emits one info line with event, ttl_minutes, removed_count, ran_at after a productive sweep', async () => {
    const { uploadedAt } = await seedBulkDownloadZip(storage, 'oplog-productive');
    const info = vi.fn();
    const error = vi.fn();
    const ttlMinutes = 1;
    const now = new Date(uploadedAt.getTime() + 70 * SECOND_MS);

    await runBulkDownloadReaper({
      storage,
      logger: { info, error },
      ttlMinutes,
      now,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    const [context, eventName] = info.mock.calls[0]!;
    expect(eventName).toBe(EVENT_BULK_DOWNLOAD_REAPER);
    const ctx = context as Record<string, unknown>;
    expect(ctx.event).toBe(EVENT_BULK_DOWNLOAD_REAPER);
    expect(ctx.ttl_minutes).toBe(ttlMinutes);
    expect(ctx.removed_count).toBe(1);
    expect(typeof ctx.ran_at).toBe('string');
    expect(Number.isNaN(Date.parse(ctx.ran_at as string))).toBe(false);
    // `ran_at` round-trips to the injected wall clock.
    expect(Date.parse(ctx.ran_at as string)).toBe(now.getTime());
  });

  // -------------------------------------------------------------------
  // Partial failure — a `hide` throw on one key must not abort
  // the sweep; the other expired keys are still removed, an error log
  // line with `error_hint` is emitted for the failing key, and the
  // final info line reports the accurate `removed_count` (successes
  // only — `bulk-download-reaper.ts` increments the counter inside the
  // success branch).
  // -------------------------------------------------------------------
  it('keeps sweeping when one hide throws; logs error_hint and continues', async () => {
    const poison = await seedBulkDownloadZip(storage, 'partial-fail-poison');
    const ok1 = await seedBulkDownloadZip(storage, 'partial-fail-ok-one');
    const ok2 = await seedBulkDownloadZip(storage, 'partial-fail-ok-two');

    // Proxy the storage client so `hide(poison.key)` throws but
    // all other calls delegate to the real client. Reaches into
    // `listObjects` too — the proxy must forward it verbatim.
    const flakyStorage: AttachmentStorageClient = {
      ...storage,
      listObjects: storage.listObjects.bind(storage),
      hide: async (key: string) => {
        if (key === poison.key) {
          throw new Error('simulated-storage-flake');
        }
        await storage.hide(key);
      },
    };

    const info = vi.fn();
    const error = vi.fn();
    const ttlMinutes = 1;
    const now = new Date(
      Math.max(poison.uploadedAt.getTime(), ok1.uploadedAt.getTime(), ok2.uploadedAt.getTime()) +
        70 * SECOND_MS,
    );

    await runBulkDownloadReaper({
      storage: flakyStorage,
      logger: { info, error },
      ttlMinutes,
      now,
    });

    // Non-poisoned keys were removed despite the poison key's failure.
    expect(await objectAbsent(storage, ok1.key)).toBe(true);
    expect(await objectAbsent(storage, ok2.key)).toBe(true);
    // Poison key is still in the bucket — we simulated a delete flake,
    // the next sweep will retry.
    expect(await objectAbsent(storage, poison.key)).toBe(false);

    // Exactly one error line, for the poison key, carrying `error_hint`.
    expect(error).toHaveBeenCalledTimes(1);
    const [errorCtx, errorEvent] = error.mock.calls[0]!;
    expect(errorEvent).toBe(EVENT_BULK_DOWNLOAD_REAPER);
    const eCtx = errorCtx as Record<string, unknown>;
    expect(eCtx.event).toBe(EVENT_BULK_DOWNLOAD_REAPER);
    expect(eCtx.key).toBe(poison.key);
    expect(typeof eCtx.error_hint).toBe('string');
    expect(eCtx.error_hint).toContain('simulated-storage-flake');

    // Info line still emitted once, with removed_count = 2 (the two
    // successful deletes). `bulk-download-reaper.ts` only increments
    // inside the success branch, so a partial failure manifests as a
    // smaller-than-listed count — not a missing info line.
    expect(info).toHaveBeenCalledTimes(1);
    const [infoCtx] = info.mock.calls[0]!;
    expect((infoCtx as { removed_count: number }).removed_count).toBe(2);

    // Housekeeping — the poison object is still there.
    await storage.hide(poison.key);
  });
});

// -------------------------------------------------------------------
// Scheduler drain — `stop()` awaits an in-flight sweep.
//
// Mirrors `audit-retention-scheduler.test.ts`. The scheduler shares its
// topology (setInterval, `currentSweep` guard, `stop()` awaits the
// in-flight promise) with `startAttachmentOrphanReaperScheduler`; this
// test locks the drain affordance specifically for the bulk-download
// scheduler so a future refactor that drops the drain would fail loud.
// Uses a stub storage + fake timers — real MinIO is not needed here.
// -------------------------------------------------------------------
describe('startBulkDownloadReaperScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stop() awaits an in-flight sweep before resolving', async () => {
    let releaseSweep!: () => void;
    const blocker = new Promise<string[]>((resolve) => {
      releaseSweep = () => resolve([]);
    });

    // Minimal storage stub — the scheduler only touches `listObjects`
    // and `hide` through the reaper, and we want listObjects to hang so
    // the sweep stays in-flight.
    const storage: AttachmentStorageClient = {
      upload: vi.fn(),
      download: vi.fn(),
      getSignedUrl: vi.fn(),
      ping: vi.fn(),
      listObjects: () => blocker,
      hide: vi.fn(),
    } as unknown as AttachmentStorageClient;

    const logger = {
      info: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
      error: vi.fn<(ctx: Record<string, unknown>, event: string) => void>(),
    };

    const scheduler = startBulkDownloadReaperScheduler({
      storage,
      intervalMinutes: 1,
      ttlMinutes: 15,
      logger,
    });

    // Fire the interval — sweep starts but hangs on `listObjects`.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(logger.info).not.toHaveBeenCalled();

    let stopSettled = false;
    const stopPromise = scheduler.stop().then(() => {
      stopSettled = true;
    });

    // Yield microtasks — if `stop()` did not await the in-flight sweep,
    // `stopSettled` would already be true.
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    // Releasing the sweep unblocks the reaper; the resulting empty list
    // triggers the single info line, and `stop()` finally resolves.
    releaseSweep();
    await stopPromise;
    expect(stopSettled).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
