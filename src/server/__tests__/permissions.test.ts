/**
 * API integration tests: Role-based permission enforcement.
 *
 * Verifies that the permission middleware correctly blocks or allows
 * operations based on user roles:
 *   - worker / bookkeeper: can read, cannot transition or update dates
 *   - owner / office: can read, transition, and update dates
 *
 * Seed users (from seed.ts):
 *   - inhaber / changeme  — owner
 *   - buero / changeme    — office
 *   - arbeiter1 / changeme — worker
 *   - buchhalter / changeme — bookkeeper
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost, authPatch } from '../../test/api-helpers.js';

/** Helper: find the first project in a given status from the list endpoint. */
async function findProjectByStatus(
  token: string,
  status: string,
): Promise<Record<string, unknown>> {
  const res = await authGet(token, '/api/projects');
  const projects = res.json().data as Record<string, unknown>[];
  const match = projects.find((p) => p.status === status);
  if (!match) throw new Error(`No project with status "${status}" in seed data`);
  return match;
}

describe('Role-based Permission Enforcement', () => {
  let workerToken: string;
  let bookkeeperToken: string;
  let ownerToken: string;
  let officeToken: string;

  beforeAll(async () => {
    await startApp();
    [workerToken, bookkeeperToken, ownerToken, officeToken] = await Promise.all([
      login('arbeiter1', 'changeme'),
      login('buchhalter', 'changeme'),
      login('inhaber', 'changeme'),
      login('buero', 'changeme'),
    ]);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // Worker — restricted role
  // ---------------------------------------------------------------
  describe('Worker (arbeiter1)', () => {
    it('cannot transition forward — returns 403 NOT_PERMITTED', async () => {
      const project = await findProjectByStatus(workerToken, 'geplant');

      const res = await authPost(workerToken, `/api/projects/${project.id}/transition/forward`);

      expect(res.statusCode).toBe(403);

      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('cannot transition backward — returns 403 NOT_PERMITTED', async () => {
      const project = await findProjectByStatus(workerToken, 'in_arbeit');

      const res = await authPost(workerToken, `/api/projects/${project.id}/transition/backward`);

      expect(res.statusCode).toBe(403);

      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('cannot update dates — returns 403 NOT_PERMITTED', async () => {
      const project = await findProjectByStatus(workerToken, 'geplant');

      const res = await authPatch(workerToken, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-10-01',
        plannedEnd: '2026-10-15',
      });

      expect(res.statusCode).toBe(403);

      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('CAN read projects — returns 200', async () => {
      const res = await authGet(workerToken, '/api/projects');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // Bookkeeper — restricted role
  // ---------------------------------------------------------------
  describe('Bookkeeper (buchhalter)', () => {
    it('cannot transition forward — returns 403 NOT_PERMITTED', async () => {
      const project = await findProjectByStatus(bookkeeperToken, 'geplant');

      const res = await authPost(bookkeeperToken, `/api/projects/${project.id}/transition/forward`);

      expect(res.statusCode).toBe(403);

      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('cannot transition backward — returns 403 NOT_PERMITTED', async () => {
      const project = await findProjectByStatus(bookkeeperToken, 'in_arbeit');

      const res = await authPost(
        bookkeeperToken,
        `/api/projects/${project.id}/transition/backward`,
      );

      expect(res.statusCode).toBe(403);

      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('cannot update dates — returns 403 NOT_PERMITTED', async () => {
      const project = await findProjectByStatus(bookkeeperToken, 'geplant');

      const res = await authPatch(bookkeeperToken, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-10-01',
        plannedEnd: '2026-10-15',
      });

      expect(res.statusCode).toBe(403);

      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('CAN read projects — returns 200', async () => {
      const res = await authGet(bookkeeperToken, '/api/projects');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // Owner — full access
  // ---------------------------------------------------------------
  describe('Owner (inhaber)', () => {
    it('can transition forward — returns 200', async () => {
      const project = await findProjectByStatus(ownerToken, 'abnahme');

      const res = await authPost(ownerToken, `/api/projects/${project.id}/transition/forward`);

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.id).toBe(project.id);
      expect(updated.status).toBe('rechnung_faellig');
    });
  });

  // ---------------------------------------------------------------
  // Office — full access
  // ---------------------------------------------------------------
  describe('Office (buero)', () => {
    it('can transition forward — returns 200', async () => {
      // Use a project that hasn't been transitioned by the owner test above.
      // anfrage -> angebot is safe since seed has 2 anfrage projects.
      const project = await findProjectByStatus(officeToken, 'anfrage');

      const res = await authPost(officeToken, `/api/projects/${project.id}/transition/forward`);

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.id).toBe(project.id);
      expect(updated.status).toBe('angebot');
    });
  });
});
