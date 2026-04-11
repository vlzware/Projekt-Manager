/**
 * API integration tests: Project state transitions.
 *
 * Tests AT-9 through AT-11 (and backward success) from the test specification
 * (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * All project operations require authentication. Tests use the `login` helper
 * to obtain a session token before making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPatch, authPost } from '../../test/api-helpers.js';
import { WORKFLOW_ORDER } from '../../config/stateConfig.js';

/** ISO 8601 date-time regex (loose — allows date-only or full timestamp) */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;

describe('Project Operations — Transitions', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
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
  // B F-1: Mutation responses must include assignedWorkers.
  //
  // Prior to this fix, transitionForward, transitionBackward, and
  // updateDates all returned the updated project with
  // assignedWorkers: null regardless of the join-table state — the
  // catch was that toProject() defaults workers to [], which the
  // projection collapses to null. The api.md §14.2.2 contract says
  // every mutation returns "the full project object" so the client
  // can update its local state without a second fetch; dropping the
  // workers silently broke that contract. The kickoff principle says
  // silent data corruption / contract violations of this class are
  // urgent regardless of whether today's frontend happens to avoid
  // tripping on them.
  // ---------------------------------------------------------------
  describe('B F-1: mutation responses include assignedWorkers', () => {
    let projectId: string;
    let workerIds: string[];

    beforeAll(async () => {
      // Look up seeded worker user IDs via /api/auth/me for each.
      const worker1Token = await login('arbeiter1', 'changeme');
      const worker2Token = await login('arbeiter2', 'changeme');
      const w1 = (await authGet(worker1Token, '/api/auth/me')).json();
      const w2 = (await authGet(worker2Token, '/api/auth/me')).json();
      workerIds = [w1.id, w2.id];

      // Bulk-import a fresh project with two assigned workers — avoids
      // depending on seed shape (seed.ts does not pre-populate the
      // project_workers join table).
      const importRes = await authPost(token, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-BF1-WORKERS',
            title: 'workers-in-response regression fixture',
            customer: { name: 'Kunde BF1' },
            status: 'geplant',
            assignedWorkerIds: workerIds,
          },
        ],
      });
      expect(importRes.statusCode).toBe(200);
      expect(importRes.json().imported).toBe(1);

      // Fetch it back to get the id.
      const listRes = await authGet(token, '/api/projects');
      const fixture = listRes
        .json()
        .data.find((p: Record<string, unknown>) => p.number === 'IMP-BF1-WORKERS');
      expect(fixture).toBeDefined();
      projectId = fixture.id;

      // Sanity: GET returns both workers — baseline for the mutation tests.
      const getRes = await authGet(token, `/api/projects/${projectId}`);
      const fetched = getRes.json();
      expect(Array.isArray(fetched.assignedWorkers)).toBe(true);
      expect(fetched.assignedWorkers).toHaveLength(2);
    });

    it('transitionForward response includes assignedWorkers', async () => {
      const res = await authPost(token, `/api/projects/${projectId}/transition/forward`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(projectId);
      expect(Array.isArray(body.assignedWorkers)).toBe(true);
      expect(body.assignedWorkers).toHaveLength(2);
      const returnedIds = (body.assignedWorkers as { userId: string; displayName: string }[])
        .map((w) => w.userId)
        .sort();
      expect(returnedIds).toEqual([...workerIds].sort());
    });

    it('transitionBackward response includes assignedWorkers', async () => {
      // After the forward test the project is in `in_arbeit`; move it
      // back to `geplant` for a symmetric assertion.
      const res = await authPost(token, `/api/projects/${projectId}/transition/backward`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.assignedWorkers)).toBe(true);
      expect(body.assignedWorkers).toHaveLength(2);
    });

    it('updateDates response includes assignedWorkers', async () => {
      const res = await authPatch(token, `/api/projects/${projectId}/dates`, {
        plannedStart: '2026-10-01',
        plannedEnd: '2026-10-15',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.assignedWorkers)).toBe(true);
      expect(body.assignedWorkers).toHaveLength(2);
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
  // Transition backward (success case)
  // Backward counterpart of AT-9.
  // Covers api.md §14.2.2: Transition backward moves status back by
  // one step and sets status, statusChangedAt, updatedAt, updatedBy.
  // ---------------------------------------------------------------
  describe('Transition backward (success)', () => {
    it('moves a project from in_arbeit back to geplant', async () => {
      // Explicit setup: transition a `geplant` project forward to `in_arbeit`
      // before testing the backward path. This keeps the test independent of
      // prior test execution — AT-9 and this test no longer share state, so
      // reordering or `--grep` filtering cannot break this case.
      const listRes = await authGet(token, '/api/projects');
      const geplantProject = listRes
        .json()
        .data.find((p: Record<string, unknown>) => p.status === 'geplant');
      expect(geplantProject).toBeDefined();

      const fwdRes = await authPost(token, `/api/projects/${geplantProject.id}/transition/forward`);
      expect(fwdRes.statusCode).toBe(200);
      const inArbeitProject = fwdRes.json();
      expect(inArbeitProject.status).toBe('in_arbeit');

      const originalStatusChangedAt = inArbeitProject.statusChangedAt;
      const originalUpdatedAt = inArbeitProject.updatedAt;

      // Now the actual assertion: backward from in_arbeit returns to geplant.
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
  // Full forward chain: every edge in WORKFLOW_ORDER
  //
  // Drives a single project from `anfrage` all the way to `erledigt`,
  // asserting each intermediate state. This covers every forward edge
  // in the 9-state workflow (8 transitions) at the HTTP layer.
  //
  // The AT-9 block above only spot-checks a couple of transitions; this
  // block closes the gap without relying on the seed having a project
  // in every possible state.
  // ---------------------------------------------------------------
  describe('full workflow forward chain', () => {
    it('transitions a project through every state from anfrage to erledigt', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projectList = listRes.json().data;
      const start = projectList.find((p: Record<string, unknown>) => p.status === 'anfrage');
      expect(start).toBeDefined();

      const currentId = start.id;
      // Walk every forward edge: each call should move the status from
      // WORKFLOW_ORDER[i] to WORKFLOW_ORDER[i+1]. The id never changes.
      for (let i = 0; i < WORKFLOW_ORDER.length - 1; i++) {
        const expectedAfter = WORKFLOW_ORDER[i + 1]!;

        const res = await authPost(token, `/api/projects/${currentId}/transition/forward`);
        expect(res.statusCode).toBe(200);

        const updated = res.json();
        expect(updated.status).toBe(expectedAfter);
        expect(updated.id).toBe(currentId);
      }
    });
  });

  // ---------------------------------------------------------------
  // NOT_FOUND path: preserves coverage of ProjectNotFoundError at the
  // HTTP boundary. Was previously covered in project-transitions.unit.test.ts
  // (deleted in the .unit consolidation); the HTTP layer only tested
  // 404 for GET /api/projects/:id, not for POST .../transition/*.
  // ---------------------------------------------------------------
  describe('transition on nonexistent project', () => {
    it('returns 404 NOT_FOUND when forwarding a well-formed but nonexistent UUID', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await authPost(token, `/api/projects/${fakeId}/transition/forward`);

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND when going backward on a nonexistent UUID', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await authPost(token, `/api/projects/${fakeId}/transition/backward`);

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });
});
