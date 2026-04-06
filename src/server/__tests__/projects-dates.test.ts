/**
 * API integration tests: Project date updates.
 *
 * Tests AT-12 and AT-13 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * All project operations require authentication. Tests use the `login` helper
 * to obtain a session token before making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPatch } from '../../test/api-helpers.js';

/** ISO 8601 date-time regex (loose — allows date-only or full timestamp) */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;

describe('Project Operations — Dates', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
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
});
