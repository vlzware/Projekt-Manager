/**
 * API integration test: public backup-status route (AC-176).
 *
 * Pins the unauthenticated GET /api/backup/status contract:
 * - No auth required; no cookie, no header.
 * - Response body is the allowlist defined in data-model.md §5.9 —
 *   any column added to `meta_backup_status` later that isn't
 *   explicitly allowlisted in `routes/backup.ts` MUST NOT appear here.
 * - `{ available: false }` is the misleading-state-free fallback when
 *   the status row is unreachable (covered by the route's unit path;
 *   integration would require tearing down the shared pool mid-test).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, getApp } from '../../test/api-helpers.js';

const ALLOWED_STATUS_FIELDS = new Set([
  'lastBackupAt',
  'lastBackupOk',
  'lastDrillAt',
  'lastDrillOk',
  'lastError',
  'updatedAt',
]);

describe('GET /api/backup/status (AC-176)', () => {
  beforeAll(async () => {
    await startApp();
  });

  afterAll(async () => {
    await stopApp();
  });

  it('responds without authentication', async () => {
    const res = await getApp().inject({ method: 'GET', url: '/api/backup/status' });
    expect(res.statusCode).toBe(200);
  });

  it('returns the available envelope with the allowlisted status fields', async () => {
    const res = await getApp().inject({ method: 'GET', url: '/api/backup/status' });
    const body = res.json() as { available: boolean; status?: Record<string, unknown> };

    expect(body.available).toBe(true);
    expect(body.status).toBeDefined();

    // Every key on the response must be on the data-model.md §5.9 allowlist.
    // If a future column leaks through, this assertion fails loudly.
    const presentKeys = Object.keys(body.status ?? {});
    for (const key of presentKeys) {
      expect(ALLOWED_STATUS_FIELDS.has(key)).toBe(true);
    }

    expect(typeof body.status?.lastBackupOk).toBe('boolean');
    expect(typeof body.status?.updatedAt).toBe('string');
  });

  it('does not leak a Set-Cookie header (no session side effects)', async () => {
    const res = await getApp().inject({ method: 'GET', url: '/api/backup/status' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
