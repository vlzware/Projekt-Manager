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
    worker1Id = w1.json().user.id;
    const w2Token = await login('arbeiter2', 'changeme');
    const w2 = await authGet(w2Token, '/api/auth/me');
    worker2Id = w2.json().user.id;
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
    it('skips items where plannedEnd is before plannedStart (ordering invariant)', async () => {
      // The single-row updateDates path rejects this in project-dates.ts
      // via DateValidationError. Without the matching check in the bulk
      // path, an import could write rows with end < start — and the DB
      // CHECK constraint only enforces "end requires start", not ordering.
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-ORDER',
            title: 'end before start',
            customer: { name: 'Testkunde' },
            plannedStart: '2026-06-15',
            plannedEnd: '2026-06-10',
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].index).toBe(0);
      expect(body.errors[0].message).toBe('Das Enddatum darf nicht vor dem Startdatum liegen.');
    });

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

    it('rejects an array exceeding the maxItems cap (C-5 DoS guard)', async () => {
      // The schema caps `projects` at maxItems: 1000. 1001 items must fail
      // at the Fastify JSON schema layer, NOT fall into the service loop.
      const oversized = Array.from({ length: 1001 }, (_, i) => ({
        number: `IMP-CAP-${i}`,
        title: `Cap test ${i}`,
        customer: { name: 'Kunde' },
      }));
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: oversized,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  // ---------------------------------------------------------------
  // Database-error translation (consolidation review C-5)
  // ---------------------------------------------------------------
  // The bulk-import catch block used to forward `err.message` verbatim,
  // which leaked node-postgres constraint names, table names, column
  // names, and English SQL fragments to the client. The fix translates
  // pg error codes into opaque German messages and logs the real error
  // server-side only. These tests pin that contract — a regression that
  // reintroduces raw pg.message forwarding WILL break these assertions.
  describe('Database error translation (no leaks)', () => {
    it('translates a duplicate number into a safe German message', async () => {
      // First import establishes the number.
      const first = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-DUP-1',
            title: 'First insert',
            customer: { name: 'Kunde Dup' },
          },
        ],
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().imported).toBe(1);

      // Second import re-uses the same number → pg SQLSTATE 23505.
      const second = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-DUP-1',
            title: 'Duplicate insert',
            customer: { name: 'Kunde Dup' },
          },
        ],
      });
      expect(second.statusCode).toBe(200);
      const body = second.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].index).toBe(0);

      const msg = body.errors[0].message as string;

      // Positive: the translated German message is returned.
      expect(msg).toBe('Projektnummer ist bereits vergeben.');

      // Negative leak guards. If any of these substrings start appearing,
      // the translation layer has been bypassed and the real pg error is
      // reaching the wire again.
      const forbiddenSubstrings = [
        'duplicate key',
        'unique constraint',
        'projects_number',
        'violates',
        'relation',
        'constraint',
        'SQLSTATE',
        '23505',
        'pg',
      ];
      for (const needle of forbiddenSubstrings) {
        expect(msg.toLowerCase()).not.toContain(needle.toLowerCase());
      }
    });

    it('translates an invalid assignedWorkerId (FK violation) into a safe German message', async () => {
      // Use a syntactically valid UUID that does not reference any user.
      // Validation passes the UUID format check; the insert then trips the
      // project_workers FK to users.id → pg SQLSTATE 23503.
      const res = await authPost(ownerToken, '/api/projects/bulk/import', {
        projects: [
          {
            number: 'IMP-FK-1',
            title: 'FK violation',
            customer: { name: 'Kunde FK' },
            assignedWorkerIds: ['00000000-0000-0000-0000-000000000000'],
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      const msg = body.errors[0].message as string;

      expect(msg).toBe('Verknüpfter Datensatz existiert nicht (z. B. zugeordnete Mitarbeiter).');

      const forbiddenSubstrings = [
        'foreign key',
        'violates',
        'project_workers',
        'constraint',
        'SQLSTATE',
        '23503',
      ];
      for (const needle of forbiddenSubstrings) {
        expect(msg.toLowerCase()).not.toContain(needle.toLowerCase());
      }
    });
  });
});
