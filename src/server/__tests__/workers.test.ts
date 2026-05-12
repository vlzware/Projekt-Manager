/**
 * API integration tests: GET /api/workers — assignable-worker pool for
 * the project-management page's Mitarbeiter filter.
 *
 * Contract:
 *   - Returns active users that hold the `worker` role, projection
 *     `{userId, displayName}`, ordered by displayName.
 *   - Excludes inactive users and users without the `worker` role.
 *   - Gated by `project:read` (every role that can list projects can
 *     populate the filter dropdown — owner, office, worker, bookkeeper).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('GET /api/workers', () => {
  let ownerToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
    bookkeeperToken = await login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('returns active worker-role users with the minimal projection', async () => {
    const res = await authGet(ownerToken, '/api/workers');
    expect(res.statusCode).toBe(200);

    const body = res.json() as { data: { userId: string; displayName: string }[] };
    expect(Array.isArray(body.data)).toBe(true);

    // Both seeded active workers must appear.
    const names = body.data.map((w) => w.displayName);
    expect(names).toContain(SEED_USERS.worker1.displayName);
    expect(names).toContain(SEED_USERS.worker2.displayName);

    // Every entry exposes only userId and displayName — no roles, email, etc.
    for (const entry of body.data) {
      expect(Object.keys(entry).sort()).toEqual(['displayName', 'userId']);
      expect(typeof entry.userId).toBe('string');
      expect(typeof entry.displayName).toBe('string');
    }
  });

  it('excludes the inactive worker', async () => {
    const res = await authGet(ownerToken, '/api/workers');
    const body = res.json() as { data: { userId: string; displayName: string }[] };
    const names = body.data.map((w) => w.displayName);
    expect(names).not.toContain(SEED_USERS.inactive.displayName);
  });

  it('excludes non-worker roles (owner, office, bookkeeper)', async () => {
    const res = await authGet(ownerToken, '/api/workers');
    const body = res.json() as { data: { userId: string; displayName: string }[] };
    const names = body.data.map((w) => w.displayName);
    expect(names).not.toContain(SEED_USERS.owner.displayName);
    expect(names).not.toContain(SEED_USERS.office.displayName);
    expect(names).not.toContain(SEED_USERS.bookkeeper.displayName);
  });

  it('orders results by displayName ascending', async () => {
    const res = await authGet(ownerToken, '/api/workers');
    const body = res.json() as { data: { userId: string; displayName: string }[] };
    const names = body.data.map((w) => w.displayName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('worker role can call the endpoint (project:read)', async () => {
    const res = await authGet(workerToken, '/api/workers');
    expect(res.statusCode).toBe(200);
  });

  it('bookkeeper role can call the endpoint (project:read)', async () => {
    const res = await authGet(bookkeeperToken, '/api/workers');
    expect(res.statusCode).toBe(200);
  });
});
