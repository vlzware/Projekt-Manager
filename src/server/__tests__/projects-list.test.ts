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
      // Seed has exactly 19 projects (data-model.md §7.1).
      expect(body.data.length).toBe(19);
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

    it('seed mixes customers with and without addresses', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();

      // Coverage claim about the seed: both variants must be present so
      // UI tests downstream can exercise both branches. Address now lives
      // on the nested customer entity (data-model.md §5.6).
      const withAddress = body.data.filter((p: Record<string, unknown>) => {
        const c = p.customer as Record<string, unknown> | null;
        return c?.address != null;
      });
      const withoutAddress = body.data.filter((p: Record<string, unknown>) => {
        const c = p.customer as Record<string, unknown> | null;
        return c?.address == null;
      });
      expect(withAddress.length).toBeGreaterThan(0);
      expect(withoutAddress.length).toBeGreaterThan(0);
    });

    it('includes projects across multiple workflow states', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();

      const states = new Set(body.data.map((p: Record<string, unknown>) => p.status));
      // Seed data covers all 9 states
      expect(states.size).toBe(9);
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
