/**
 * API integration tests: Project operations.
 *
 * Tests AT-8 through AT-15 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * All project operations require authentication. Tests use the `login` helper
 * to obtain a session token before making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startApp,
  stopApp,
  getApp,
  login,
  authGet,
  authPost,
  authPatch,
} from '../../test/api-helpers.js';

/** ISO 8601 date-time regex (loose — allows date-only or full timestamp) */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;

describe('Project Operations', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-8: List projects returns all seeded projects with correct fields
  // ---------------------------------------------------------------
  describe('AT-8: List projects', () => {
    it('returns 200 with an array of projects', async () => {
      const res = await authGet(token, '/api/projects');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      // Seed has 15-20 projects (data-model.md §7.1 specifies 15-20)
      expect(body.data.length).toBeGreaterThanOrEqual(15);
      expect(body.data.length).toBeLessThanOrEqual(20);
    });

    it('each project has the required fields with correct types', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();
      const project = body.data[0];

      // Required fields
      expect(typeof project.id).toBe('string');
      expect(typeof project.number).toBe('string');
      expect(typeof project.title).toBe('string');
      expect(typeof project.status).toBe('string');
      expect(project.statusChangedAt).toMatch(ISO_DATE_REGEX);
      expect(project.createdAt).toMatch(ISO_DATE_REGEX);
      expect(project.updatedAt).toMatch(ISO_DATE_REGEX);

      // Customer is a required nested object
      expect(project.customer).toBeDefined();
      expect(typeof project.customer.name).toBe('string');
    });

    it('project number follows the "YYYY-NNN" format', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();

      for (const project of body.data) {
        expect(project.number).toMatch(/^\d{4}-\d{3}$/);
      }
    });

    it('project status is a valid workflow state', async () => {
      const validStates = [
        'anfrage',
        'angebot',
        'beauftragt',
        'geplant',
        'in_arbeit',
        'abnahme',
        'rechnung_faellig',
        'abgerechnet',
        'erledigt',
      ];

      const res = await authGet(token, '/api/projects');
      const body = res.json();

      for (const project of body.data) {
        expect(validStates).toContain(project.status);
      }
    });

    it('optional fields are present when set and absent/null when not', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();

      // At least some projects should have addresses, some should not
      const withAddress = body.data.filter((p: Record<string, unknown>) => p.address != null);
      const withoutAddress = body.data.filter((p: Record<string, unknown>) => p.address == null);
      expect(withAddress.length).toBeGreaterThan(0);
      expect(withoutAddress.length).toBeGreaterThan(0);

      // Verify address structure when present
      const addressed = withAddress[0];
      expect(typeof addressed.address.street).toBe('string');
      expect(typeof addressed.address.zip).toBe('string');
      expect(typeof addressed.address.city).toBe('string');
    });

    it('includes projects across multiple workflow states', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();

      const states = new Set(body.data.map((p: Record<string, unknown>) => p.status));
      // Seed data covers all 9 states
      expect(states.size).toBe(9);
    });

    it('never includes internal database fields in the response', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();

      for (const project of body.data) {
        // No database internals should leak
        expect(project).not.toHaveProperty('_id');
        expect(project).not.toHaveProperty('__v');
      }
    });
  });

  // ---------------------------------------------------------------
  // AT-9: Transition forward changes status and statusChangedAt
  // ---------------------------------------------------------------
  describe('AT-9: Transition forward', () => {
    it('advances a project from geplant to in_arbeit', async () => {
      // First, find a project in "geplant" state
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const geplantProject = projects.find((p: Record<string, unknown>) => p.status === 'geplant');
      expect(geplantProject).toBeDefined();

      const originalStatusChangedAt = geplantProject.statusChangedAt;
      const originalUpdatedAt = geplantProject.updatedAt;

      const res = await authPost(token, `/api/projects/${geplantProject.id}/transition/forward`);

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.id).toBe(geplantProject.id);
      expect(updated.status).toBe('in_arbeit');
      expect(updated.statusChangedAt).not.toBe(originalStatusChangedAt);
      expect(updated.statusChangedAt).toMatch(ISO_DATE_REGEX);
      expect(updated.updatedAt).not.toBe(originalUpdatedAt);
      expect(updated.updatedAt).toMatch(ISO_DATE_REGEX);
    });

    it('returns the full updated project object', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find((p: Record<string, unknown>) => p.status === 'anfrage');
      expect(project).toBeDefined();

      const res = await authPost(token, `/api/projects/${project.id}/transition/forward`);

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      // Full project shape returned
      expect(updated.id).toBeDefined();
      expect(updated.number).toBeDefined();
      expect(updated.title).toBeDefined();
      expect(updated.status).toBe('angebot');
      expect(updated.customer).toBeDefined();
      expect(updated.createdAt).toBeDefined();
      expect(updated.updatedAt).toBeDefined();
      expect(updated.statusChangedAt).toBeDefined();
    });

    it('sets updatedBy to the authenticated user', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find((p: Record<string, unknown>) => p.status === 'beauftragt');
      expect(project).toBeDefined();

      // Get the authenticated user's ID
      const meRes = await authGet(token, '/api/auth/me');
      const me = meRes.json();

      const res = await authPost(token, `/api/projects/${project.id}/transition/forward`);

      const updated = res.json();
      expect(updated.updatedBy).toBe(me.id);
    });
  });

  // ---------------------------------------------------------------
  // AT-10: Transition forward from erledigt is rejected
  // ---------------------------------------------------------------
  describe('AT-10: Transition forward from erledigt', () => {
    it('returns a validation error (erledigt is terminal)', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const erledigtProject = projects.find(
        (p: Record<string, unknown>) => p.status === 'erledigt',
      );
      expect(erledigtProject).toBeDefined();

      const res = await authPost(token, `/api/projects/${erledigtProject.id}/transition/forward`);

      expect(res.statusCode).toBe(422);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // AT-11: Transition backward from anfrage is rejected
  // ---------------------------------------------------------------
  describe('AT-11: Transition backward from anfrage', () => {
    it('returns a validation error (anfrage is the first state)', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const anfrageProject = projects.find((p: Record<string, unknown>) => p.status === 'anfrage');
      expect(anfrageProject).toBeDefined();

      const res = await authPost(token, `/api/projects/${anfrageProject.id}/transition/backward`);

      expect(res.statusCode).toBe(422);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(typeof body.message).toBe('string');
    });

    it('also rejects backward from erledigt (terminal state)', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const erledigtProject = projects.find(
        (p: Record<string, unknown>) => p.status === 'erledigt',
      );
      expect(erledigtProject).toBeDefined();

      const res = await authPost(token, `/api/projects/${erledigtProject.id}/transition/backward`);

      expect(res.statusCode).toBe(422);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------
  // AT-12: Update dates changes plannedStart/plannedEnd and updatedAt
  //        but not statusChangedAt
  // ---------------------------------------------------------------
  describe('AT-12: Update dates', () => {
    it('updates plannedStart and plannedEnd', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      // Pick a project that already has dates
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart != null && p.plannedEnd != null,
      );
      expect(project).toBeDefined();

      const newStart = '2026-05-01';
      const newEnd = '2026-05-10';

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: newStart,
        plannedEnd: newEnd,
      });

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.plannedStart).toContain('2026-05-01');
      expect(updated.plannedEnd).toContain('2026-05-10');
    });

    it('updates updatedAt but NOT statusChangedAt', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart != null && p.plannedEnd != null,
      );
      expect(project).toBeDefined();

      const originalStatusChangedAt = project.statusChangedAt;
      const originalUpdatedAt = project.updatedAt;

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-06-01',
        plannedEnd: '2026-06-15',
      });

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      // statusChangedAt must NOT change — date edits are not state transitions
      expect(updated.statusChangedAt).toBe(originalStatusChangedAt);
      // updatedAt MUST change
      expect(updated.updatedAt).not.toBe(originalUpdatedAt);
      expect(updated.updatedAt).toMatch(ISO_DATE_REGEX);
    });

    it('sets updatedBy to the authenticated user', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart != null && p.plannedEnd != null,
      );
      expect(project).toBeDefined();

      const meRes = await authGet(token, '/api/auth/me');
      const me = meRes.json();

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-07-01',
        plannedEnd: '2026-07-05',
      });

      const updated = res.json();
      expect(updated.updatedBy).toBe(me.id);
    });

    it('returns the full updated project', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find((p: Record<string, unknown>) => p.plannedStart != null);
      expect(project).toBeDefined();

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-08-01',
        plannedEnd: '2026-08-20',
      });

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.id).toBe(project.id);
      expect(updated.number).toBeDefined();
      expect(updated.title).toBeDefined();
      expect(updated.status).toBe(project.status);
      expect(updated.customer).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // AT-13: Update dates with plannedEnd before plannedStart is rejected
  // ---------------------------------------------------------------
  describe('AT-13: Update dates with invalid range', () => {
    it('rejects when plannedEnd is before plannedStart', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find((p: Record<string, unknown>) => p.plannedStart != null);
      expect(project).toBeDefined();

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-06-15',
        plannedEnd: '2026-06-01', // end before start
      });

      expect(res.statusCode).toBe(422);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('rejects when only plannedEnd is set without plannedStart', async () => {
      // data-model.md §6.8: setting only plannedEnd without plannedStart is not valid
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      // Find a project without dates to test setting end-only
      const project = projects.find(
        (p: Record<string, unknown>) => p.plannedStart == null && p.plannedEnd == null,
      );
      expect(project).toBeDefined();

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedEnd: '2026-06-15',
        // No plannedStart
      });

      expect(res.statusCode).toBe(422);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('accepts plannedStart without plannedEnd (single-day block)', async () => {
      // data-model.md §6.8: plannedStart alone is valid — renders as a single-day block
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const project = projects.find((p: Record<string, unknown>) => p.plannedStart != null);
      expect(project).toBeDefined();

      const res = await authPatch(token, `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-09-01',
        // No plannedEnd — valid per spec
      });

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.plannedStart).toContain('2026-09-01');
      // plannedEnd should be absent or null after this update
      expect(updated.plannedEnd == null).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // AT-14: Change own password with correct current password succeeds
  // ---------------------------------------------------------------
  describe('AT-14: Change own password (success)', () => {
    it('changes password and allows login with the new one', async () => {
      // Self-contained: login, change, verify new password — all in one test.
      // Uses buero to avoid affecting other tests that log in as inhaber.
      const bueroToken = await login('buero', 'changeme');

      const changeRes = await authPost(bueroToken, '/api/auth/change-password', {
        currentPassword: 'changeme',
        newPassword: 'neuesPasswort123!',
      });

      expect(changeRes.statusCode).toBe(200);

      // Verify the new password works by logging in again
      const loginRes = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'buero', password: 'neuesPasswort123!' },
      });

      expect(loginRes.statusCode).toBe(200);
      // Session token is now in the cookie, not the body
      const setCookie = loginRes.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toMatch(/session=[^;]+/);
    });
  });

  // ---------------------------------------------------------------
  // AT-15: Change own password with incorrect current password is rejected
  // ---------------------------------------------------------------
  describe('AT-15: Change own password (wrong current password)', () => {
    it('rejects when current password is incorrect', async () => {
      // Uses inhaber — completely independent of AT-14's buero flow.
      const inhaberToken = await login('inhaber', 'changeme');

      const res = await authPost(inhaberToken, '/api/auth/change-password', {
        currentPassword: 'definitelywrong',
        newPassword: 'newpassword123!',
      });

      // Should not succeed
      expect(res.statusCode).not.toBe(200);
      // 401 or 422 are both reasonable; the spec says "rejected"
      expect([401, 422]).toContain(res.statusCode);

      const body = res.json();
      expect(body.code).toBeDefined();
      expect(typeof body.message).toBe('string');
    });

    it('does not change the password on rejection', async () => {
      // After the failed attempt, original password should still work.
      // Logs in fresh — no dependency on any prior test state.
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'inhaber', password: 'changeme' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------
  // Transition backward (success case)
  // Backward counterpart of AT-9.
  // Covers api.md §14.2.2: Transition backward moves status back by
  // one step and sets status, statusChangedAt, updatedAt, updatedBy.
  // ---------------------------------------------------------------
  describe('Transition backward (success)', () => {
    it('moves a project from in_arbeit back to geplant', async () => {
      // Find a project in "in_arbeit" state (AT-9 transitioned one there).
      // If none exists, transition one forward first to set up state.
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      let inArbeitProject = projects.find((p: Record<string, unknown>) => p.status === 'in_arbeit');

      // Fallback: if no in_arbeit project exists, create one by transitioning forward
      if (!inArbeitProject) {
        const geplantProject = projects.find(
          (p: Record<string, unknown>) => p.status === 'geplant',
        );
        expect(geplantProject).toBeDefined();
        const fwdRes = await authPost(
          token,
          `/api/projects/${geplantProject.id}/transition/forward`,
        );
        expect(fwdRes.statusCode).toBe(200);
        inArbeitProject = fwdRes.json();
      }

      expect(inArbeitProject.status).toBe('in_arbeit');

      const originalStatusChangedAt = inArbeitProject.statusChangedAt;
      const originalUpdatedAt = inArbeitProject.updatedAt;

      const res = await authPost(token, `/api/projects/${inArbeitProject.id}/transition/backward`);

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.id).toBe(inArbeitProject.id);
      expect(updated.status).toBe('geplant');
      expect(updated.statusChangedAt).not.toBe(originalStatusChangedAt);
      expect(updated.statusChangedAt).toMatch(ISO_DATE_REGEX);
      expect(updated.updatedAt).not.toBe(originalUpdatedAt);
      expect(updated.updatedAt).toMatch(ISO_DATE_REGEX);
    });

    it('sets updatedBy to the authenticated user', async () => {
      // Transition a project forward then backward to verify updatedBy
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      // Find a project that can go forward and then back
      const angebotProject = projects.find((p: Record<string, unknown>) => p.status === 'angebot');
      expect(angebotProject).toBeDefined();

      // Forward: angebot -> beauftragt
      const fwdRes = await authPost(token, `/api/projects/${angebotProject.id}/transition/forward`);
      expect(fwdRes.statusCode).toBe(200);
      expect(fwdRes.json().status).toBe('beauftragt');

      // Get the authenticated user's ID
      const meRes = await authGet(token, '/api/auth/me');
      const me = meRes.json();

      // Backward: beauftragt -> angebot
      const bwdRes = await authPost(
        token,
        `/api/projects/${angebotProject.id}/transition/backward`,
      );
      expect(bwdRes.statusCode).toBe(200);

      const updated = bwdRes.json();
      expect(updated.status).toBe('angebot');
      expect(updated.updatedBy).toBe(me.id);
    });
  });

  // ---------------------------------------------------------------
  // Get single project by ID
  // Covers api.md §14.2.2: "Get project — Returns the full project
  // object or a not-found error."
  // ---------------------------------------------------------------
  describe('Get single project by ID', () => {
    it('returns 200 with the full project object for a known ID', async () => {
      // Get a known project ID from the list
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      expect(projects.length).toBeGreaterThan(0);

      const knownProject = projects[0];

      const res = await authGet(token, `/api/projects/${knownProject.id}`);

      expect(res.statusCode).toBe(200);

      const body = res.json();
      // All required fields must be present
      expect(body.id).toBe(knownProject.id);
      expect(typeof body.number).toBe('string');
      expect(body.number).toMatch(/^\d{4}-\d{3}$/);
      expect(typeof body.title).toBe('string');
      expect(typeof body.status).toBe('string');
      expect(body.customer).toBeDefined();
      expect(typeof body.customer.name).toBe('string');
      expect(body.createdAt).toMatch(ISO_DATE_REGEX);
      expect(body.updatedAt).toMatch(ISO_DATE_REGEX);
      expect(body.statusChangedAt).toMatch(ISO_DATE_REGEX);
    });

    it('returns the same data as the list endpoint for the same project', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const fromList = projects[0];

      const singleRes = await authGet(token, `/api/projects/${fromList.id}`);
      const fromSingle = singleRes.json();

      // Core fields must match between list and single-get
      expect(fromSingle.id).toBe(fromList.id);
      expect(fromSingle.number).toBe(fromList.number);
      expect(fromSingle.title).toBe(fromList.title);
      expect(fromSingle.status).toBe(fromList.status);
      expect(fromSingle.customer.name).toBe(fromList.customer.name);
    });

    it('returns 404 with NOT_FOUND for a nonexistent ID', async () => {
      const res = await authGet(token, '/api/projects/00000000-0000-0000-0000-000000000000');

      expect(res.statusCode).toBe(404);

      const body = res.json();
      expect(body.code).toBe('NOT_FOUND');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });
  });
});
