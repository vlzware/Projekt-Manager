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

/** ISO 8601 date-time regex (loose — allows date-only or full timestamp) */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;

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
