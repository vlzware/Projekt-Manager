/**
 * API integration tests: Bulk project import.
 *
 * Tests the POST /api/projects/bulk/import endpoint.
 * Runs against a real test database via Fastify inject (no network).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authPost, authGet } from '../../test/api-helpers.js';

describe('Bulk Project Import', () => {
  let ownerToken: string;
  let workerToken: string;
  let worker1Id: string;
  let worker2Id: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login('inhaber', 'changeme');
    workerToken = await login('arbeiter1', 'changeme');

    // Look up seeded worker user IDs for assignedWorkerIds tests
    const w1 = await authGet(workerToken, '/api/auth/me');
    worker1Id = w1.json().id;
    const w2Token = await login('arbeiter2', 'changeme');
    const w2 = await authGet(w2Token, '/api/auth/me');
    worker2Id = w2.json().id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // Authentication & Authorization
  // ---------------------------------------------------------------
  describe('Authentication & Authorization', () => {
    it('returns 401 when not authenticated', async () => {
      const { getApp } = await import('../../test/api-helpers.js');
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/projects/bulk/import',
        payload: { projects: [] },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when user lacks project:create permission (worker role)', async () => {
      const res = await authPost(workerToken, '/api/projects/bulk/import', {
        projects: [],
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
    });

    it('returns 200 when user has project:create permission (owner role)', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  // Successful import
  // ---------------------------------------------------------------
  describe('Successful import', () => {
    it('imports valid projects and returns the count', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-001',
            title: 'Bulk Test Projekt 1',
            customer: { name: 'Testkunde A' },
          },
          {
            number: 'IMP-002',
            title: 'Bulk Test Projekt 2',
            customer: { name: 'Testkunde B' },
            status: 'beauftragt',
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(2);
      expect(body.errors).toEqual([]);
    });

    it('defaults status to anfrage when not specified', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-003',
            title: 'Default Status Test',
            customer: { name: 'Testkunde C' },
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().imported).toBe(1);

      // Verify by listing projects and finding the imported one
      const listRes = await authGet(ownerToken, '/api/projects');
      const projects = listRes.json().data;
      const imported = projects.find((p: Record<string, unknown>) => p.number === 'IMP-003');
      expect(imported).toBeDefined();
      expect(imported.status).toBe('anfrage');
    });

    it('accepts all optional fields', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-004',
            title: 'Vollstaendiges Projekt',
            customer: { name: 'Testkunde D', phone: '0123456', email: 'test@example.com' },
            status: 'geplant',
            address: { street: 'Teststr. 1', zip: '12345', city: 'Teststadt' },
            plannedStart: '2026-06-01',
            plannedEnd: '2026-06-15',
            assignedWorkerIds: [worker1Id, worker2Id],
            estimatedValue: 15000.5,
            notes: 'Testnotiz',
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().imported).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // Validation errors
  // ---------------------------------------------------------------
  describe('Validation errors', () => {
    it('skips items with plannedEnd but no plannedStart and reports the German error (#54)', async () => {
      // Before the projects_end_requires_start CHECK constraint, this
      // path inserted a row with end-only because validateImportItem did
      // not enforce the start-before-end invariant. The item-level
      // validation now rejects it with a German message, matching the
      // `updateDates` route-level error.
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-ENDONLY',
            title: 'end without start',
            customer: { name: 'Testkunde' },
            plannedEnd: '2026-06-15',
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].index).toBe(0);
      expect(body.errors[0].message).toBe('Enddatum kann nicht ohne Startdatum gesetzt werden.');
    });

    it('skips items with missing number and reports error', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            title: 'No Number',
            customer: { name: 'Testkunde' },
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].index).toBe(0);
      expect(body.errors[0].message).toContain('number');
    });

    it('skips items with missing title and reports error', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-ERR1',
            customer: { name: 'Testkunde' },
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].message).toContain('title');
    });

    it('skips items with missing customer and reports error', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-ERR2',
            title: 'No Customer',
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].message).toContain('customer');
    });

    it('skips items with missing customer.name and reports error', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-ERR3',
            title: 'No Customer Name',
            customer: {},
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].message).toContain('customer.name');
    });

    it('skips items with invalid status and reports error', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-ERR4',
            title: 'Bad Status',
            customer: { name: 'Testkunde' },
            status: 'nonexistent_state',
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].message).toContain('nonexistent_state');
    });
  });

  // ---------------------------------------------------------------
  // Mixed valid and invalid items
  // ---------------------------------------------------------------
  describe('Mixed valid and invalid items', () => {
    it('imports valid items and reports errors for invalid ones', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-MIX1',
            title: 'Valid Project',
            customer: { name: 'Kunde Mix' },
          },
          {
            // Missing number — invalid
            title: 'Invalid Project',
            customer: { name: 'Kunde Mix' },
          },
          {
            number: 'IMP-MIX2',
            title: 'Another Valid Project',
            customer: { name: 'Kunde Mix 2' },
            status: 'angebot',
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(2);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].index).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // Request validation
  // ---------------------------------------------------------------
  describe('Request validation', () => {
    it('rejects request without projects array', async () => {
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {});

      // Global error handler wraps Fastify schema validation errors as 500
      // to prevent leaking internal details. The important thing is it does not succeed.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
