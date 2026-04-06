/**
 * API integration tests: List projects.
 *
 * Test AT-8 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * All project operations require authentication. Tests use the `login` helper
 * to obtain a session token before making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet } from '../../test/api-helpers.js';

/** ISO 8601 date-time regex (loose — allows date-only or full timestamp) */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;

describe('Project Operations — List', () => {
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
  // Pagination
  // ---------------------------------------------------------------
  describe('Pagination', () => {
    it('respects limit parameter', async () => {
      const res = await authGet(token, '/api/projects?limit=3');
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBe(3);
      // total reflects full count, not the page size
      expect(body.total).toBeGreaterThanOrEqual(15);
    });

    it('respects offset parameter', async () => {
      const allRes = await authGet(token, '/api/projects');
      const all = allRes.json().data;

      const res = await authGet(token, '/api/projects?offset=2&limit=3');
      const body = res.json();

      expect(body.data.length).toBe(3);
      expect(body.data[0].id).toBe(all[2].id);
    });

    it('returns empty array when offset exceeds total', async () => {
      const res = await authGet(token, '/api/projects?offset=999&limit=10');
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBeGreaterThanOrEqual(15);
    });
  });
});
