/**
 * API integration tests: Role-based permission enforcement.
 *
 * Verifies that the permission middleware correctly blocks or allows
 * operations based on user roles:
 *   - worker / bookkeeper: can read, cannot transition or update dates
 *   - owner / office: can read, transition, and update dates
 *
 * Seed users referenced via SEED_USERS from `../../test/seedAssumptions.js`
 * (see that file for the single source of truth on usernames / passwords).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost, authPatch } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

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
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
    ]);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // Restricted roles — worker (SEED_USERS.worker1) and bookkeeper
  // (SEED_USERS.bookkeeper) share the same permission model (read-only:
  // cannot transition or update dates). Parametrized so adding/removing
  // a restricted role is a one-line change and assertions never drift
  // between the two roles.
  //
  // Tokens are looked up by role name inside each test because `it.each`
  // evaluates its table at describe-collection time, before `beforeAll`
  // has assigned the module-scoped token variables.
  // ---------------------------------------------------------------
  describe('Restricted roles (read-only)', () => {
    type RestrictedRole = 'worker' | 'bookkeeper';
    const restrictedRoles: RestrictedRole[] = ['worker', 'bookkeeper'];
    const tokenFor = (role: RestrictedRole): string =>
      role === 'worker' ? workerToken : bookkeeperToken;

    it.each(restrictedRoles)(
      '%s cannot transition forward — returns 403 NOT_PERMITTED',
      async (role) => {
        const token = tokenFor(role);
        const project = await findProjectByStatus(token, 'geplant');

        const res = await authPost(token, `/api/projects/${project.id}/transition/forward`);

        expect(res.statusCode).toBe(403);

        const body = res.json();
        expect(body.code).toBe('NOT_PERMITTED');
        expect(typeof body.message).toBe('string');
        expect(body.message.length).toBeGreaterThan(0);
      },
    );

    it.each(restrictedRoles)(
      '%s cannot transition backward — returns 403 NOT_PERMITTED',
      async (role) => {
        const token = tokenFor(role);
        const project = await findProjectByStatus(token, 'in_arbeit');

        const res = await authPost(token, `/api/projects/${project.id}/transition/backward`);

        expect(res.statusCode).toBe(403);

        const body = res.json();
        expect(body.code).toBe('NOT_PERMITTED');
        expect(typeof body.message).toBe('string');
        expect(body.message.length).toBeGreaterThan(0);
      },
    );

    it.each(restrictedRoles)('%s cannot update dates — returns 403 NOT_PERMITTED', async (role) => {
      const token = tokenFor(role);
      const project = await findProjectByStatus(token, 'geplant');

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-10-01',
        plannedEnd: '2026-10-15',
      });

      expect(res.statusCode).toBe(403);

      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it.each(restrictedRoles)('%s CAN read projects — returns 200', async (role) => {
      const res = await authGet(tokenFor(role), '/api/projects');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // Owner — full access
  // ---------------------------------------------------------------
  describe(`Owner (${SEED_USERS.owner.username})`, () => {
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
  describe(`Office (${SEED_USERS.office.username})`, () => {
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
