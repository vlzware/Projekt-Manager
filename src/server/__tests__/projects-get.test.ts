/**
 * API integration tests: Get single project.
 *
 * Covers api.md §14.2.2: "Get project — Returns the full project
 * object or a not-found error."
 * Runs against a real test database via Fastify inject (no network).
 *
 * All project operations require authentication. Tests use the `login` helper
 * to obtain a session token before making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet } from '../../test/api-helpers.js';

describe('Project Operations — Get Single', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // Get single project by ID
  // Covers api.md §14.2.2: "Get project — Returns the full project
  // object or a not-found error."
  // ---------------------------------------------------------------
  describe('Get single project by ID', () => {
    it('returns 200 with the project matching the requested ID', async () => {
      // Get a known project ID from the list
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      expect(projects.length).toBeGreaterThan(0);

      const knownProject = projects[0];

      const res = await authGet(token, `/api/projects/${knownProject.id}`);

      expect(res.statusCode).toBe(200);

      const body = res.json();
      // Behavior: the endpoint returns the project we asked for.
      expect(body.id).toBe(knownProject.id);
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
