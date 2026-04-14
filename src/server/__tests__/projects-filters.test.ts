/**
 * API integration tests: Project list filters.
 *
 * Tests AT-39 to AT-41 from the test specification (verification.md §16.3).
 * Extends the list endpoint (AT-8 in projects-list.test.ts) with filter coverage.
 * Runs against a real test database via Fastify inject (no network).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the filter contract for the GET /api/projects endpoint.
 *
 * Spec §14.2.2 filter parameters:
 *   - status: single or multiple workflow states
 *   - search: free-text across number, title, customer name
 *   - hasNoDates: boolean — projects without planned dates
 *   - customerId: FK reference
 *   - plannedStartFrom / plannedStartTo: date range
 *   - All filters use AND logic
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Project List Filters', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-39: Status filter
  // ---------------------------------------------------------------
  describe('AT-39: Filter by status', () => {
    it('returns only projects matching a single status', async () => {
      const res = await authGet(token, '/api/projects?status=rechnung_faellig');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      for (const project of body.data) {
        expect(project.status).toBe('rechnung_faellig');
      }

      // total reflects the filtered count, not all projects
      expect(body.total).toBe(body.data.length);
    });

    it('returns only projects matching multiple statuses', async () => {
      const res = await authGet(token, '/api/projects?status=anfrage&status=angebot');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const project of body.data) {
        expect(['anfrage', 'angebot']).toContain(project.status);
      }
    });

    it('returns empty result for unused status', async () => {
      // Discover which statuses have data in the seed
      const allRes = await authGet(token, '/api/projects?limit=200');
      const usedStatuses = new Set(
        allRes.json().data.map((p: Record<string, unknown>) => p.status),
      );

      const validStates = [
        'anfrage',
        'angebot',
        'geplant',
        'in_arbeit',
        'fertiggestellt',
        'rechnung_faellig',
        'rechnung_bezahlt',
        'storniert',
        'erledigt',
      ];
      const unused = validStates.find((s) => !usedStatuses.has(s));

      if (!unused) {
        // All 9 states populated by seed — empty-result case not testable
        // without data mutation. Single-status test above covers filter correctness.
        return;
      }

      const res = await authGet(token, `/api/projects?status=${unused}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
      expect(res.json().total).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // AT-40: Search parameter
  // ---------------------------------------------------------------
  describe('AT-40: Search across number, title, customer name', () => {
    it('finds projects by number substring', async () => {
      // Get a known project number from seed
      const allRes = await authGet(token, '/api/projects?limit=1');
      const knownNumber = allRes.json().data[0].number as string;
      // Search by the year prefix (e.g., "2026")
      const yearPrefix = knownNumber.split('-')[0];

      const res = await authGet(token, `/api/projects?search=${yearPrefix}`);

      expect(res.statusCode).toBe(200);
      expect(res.json().data.length).toBeGreaterThanOrEqual(1);
    });

    it('finds projects by title substring', async () => {
      // Seed titles include German construction terms like "Fassade", "Treppenhaussanierung"
      // Use a generic German construction term that should match at least one seed project
      const res = await authGet(token, '/api/projects?search=Fassade');

      expect(res.statusCode).toBe(200);
      // At least one seed project should have "Fassade" in its title
      expect(res.json().data.length).toBeGreaterThanOrEqual(1);
    });

    it('finds projects by customer name substring', async () => {
      // Seed customers include "Müller" (spec §7.3)
      const res = await authGet(token, '/api/projects?search=Müller');

      expect(res.statusCode).toBe(200);
      expect(res.json().data.length).toBeGreaterThanOrEqual(1);
    });

    it('search is case-insensitive', async () => {
      const lower = await authGet(token, '/api/projects?search=fassade');
      const upper = await authGet(token, '/api/projects?search=FASSADE');

      expect(lower.json().data.length).toBe(upper.json().data.length);
    });

    it('returns empty when search has no match', async () => {
      const res = await authGet(token, '/api/projects?search=DefinitelyNoMatchXYZ789');

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
      expect(res.json().total).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // AT-41: hasNoDates filter
  // ---------------------------------------------------------------
  describe('AT-41: Filter by hasNoDates', () => {
    it('returns only projects without planned dates', async () => {
      const res = await authGet(token, '/api/projects?hasNoDates=true');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1); // Seed has projects without dates

      for (const project of body.data) {
        expect(project.plannedStart).toBeNull();
        expect(project.plannedEnd).toBeNull();
      }
    });

    it('total reflects filtered count', async () => {
      const allRes = await authGet(token, '/api/projects');
      const noDatesCount = allRes
        .json()
        .data.filter(
          (p: Record<string, unknown>) => p.plannedStart == null && p.plannedEnd == null,
        ).length;

      const res = await authGet(token, '/api/projects?hasNoDates=true');
      expect(res.json().total).toBe(noDatesCount);
    });
  });

  // ---------------------------------------------------------------
  // Combined filters (AND logic)
  // ---------------------------------------------------------------
  describe('Combined filters', () => {
    it('status + search uses AND logic', async () => {
      const res = await authGet(token, '/api/projects?status=anfrage&search=Müller');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      for (const project of body.data) {
        expect(project.status).toBe('anfrage');
      }

      // Verify AND logic: combined result must be a subset of search-only results
      const searchOnly = await authGet(token, '/api/projects?search=Müller');
      const searchIds = new Set(searchOnly.json().data.map((p: Record<string, unknown>) => p.id));
      for (const project of body.data) {
        expect(searchIds.has(project.id)).toBe(true);
      }
    });

    it('pagination works with filters', async () => {
      const res = await authGet(token, '/api/projects?status=rechnung_faellig&limit=1&offset=0');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeLessThanOrEqual(1);
      // total still reflects the full filtered count, not the page
      expect(body.total).toBeGreaterThanOrEqual(body.data.length);
    });
  });
});
