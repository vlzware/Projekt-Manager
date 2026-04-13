/**
 * API integration tests: Export operations.
 *
 * Tests AT-36, AT-37 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the API contract for data export introduced in iteration 6.
 *
 * Route conventions:
 *   GET /api/export/projects     → export projects (JSON, with optional filters)
 *   GET /api/export/customers    → export customers (JSON, with optional filters)
 *
 * Spec §14.2.4 semantics:
 *   - Export returns full entity shape (no truncation)
 *   - Projects: excludes soft-deleted; filters: status, customerId, date range
 *   - Customers: all; filters: has-projects, no-projects
 *   - Format defaults to JSON; `format` param exists for future extensibility
 *   - Permissions: project:read for projects, customer:read for customers
 *     (all authenticated users have both)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  createTestUserSession,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Export Operations', () => {
  let ownerToken: string;
  let workerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-36: Export projects
  // AC-71 [crit], AC-73 [crit]
  // ---------------------------------------------------------------
  describe('AT-36: Export projects', () => {
    it('returns all non-deleted projects as JSON array', async () => {
      const res = await authGet(ownerToken, '/api/export/projects');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(15); // Seed has 15-20 projects

      // Verify full entity shape (not truncated)
      const first = body[0];
      expect(first.id).toBeDefined();
      expect(first.number).toBeDefined();
      expect(first.title).toBeDefined();
      expect(first.status).toBeDefined();
    });

    it('excludes soft-deleted projects', async () => {
      const res = await authGet(ownerToken, '/api/export/projects');
      const body = res.json();

      for (const project of body) {
        expect(project.deleted).not.toBe(true);
      }
    });

    it('filters by status', async () => {
      const res = await authGet(ownerToken, '/api/export/projects?status=rechnung_faellig');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.length).toBeGreaterThanOrEqual(1);

      for (const project of body) {
        expect(project.status).toBe('rechnung_faellig');
      }
    });

    it('filters by multiple statuses', async () => {
      const res = await authGet(ownerToken, '/api/export/projects?status=anfrage&status=angebot');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.length).toBeGreaterThanOrEqual(1);
      for (const project of body) {
        expect(['anfrage', 'angebot']).toContain(project.status);
      }
    });

    it('returns empty array when filter matches nothing', async () => {
      // Use a non-existent customerId — should yield empty
      const res = await authGet(
        ownerToken,
        '/api/export/projects?customerId=00000000-0000-0000-0000-000000000000',
      );

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('all authenticated users can export (worker has project:read)', async () => {
      const res = await authGet(workerToken, '/api/export/projects');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it('unauthenticated users cannot export', async () => {
      const { getApp } = await import('../../test/api-helpers.js');
      const res = await getApp().inject({
        method: 'GET',
        url: '/api/export/projects',
      });

      expect(res.statusCode).toBe(401);
    });

    it('users with no permissions are rejected', async () => {
      const session = await createTestUserSession({ roles: [] });
      const res = await authGet(session.token, '/api/export/projects');

      expect(res.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------
  // AT-37: Export customers
  // AC-72 [crit]
  // ---------------------------------------------------------------
  describe('AT-37: Export customers', () => {
    it('returns all customers as JSON array', async () => {
      const res = await authGet(ownerToken, '/api/export/customers');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);

      // Verify full entity shape
      const first = body[0];
      expect(first.id).toBeDefined();
      expect(first.name).toBeDefined();
    });

    it('filters by has-projects — excludes customers without projects', async () => {
      // Create a customer with no projects as a control
      const createRes = await authPost(ownerToken, '/api/customers', {
        name: 'Export HasProjects Control',
      });
      const noProjectId = createRes.json().id;

      const res = await authGet(ownerToken, '/api/export/customers?hasProjects=true');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.length).toBeGreaterThanOrEqual(1);

      // The control customer (no projects) must NOT appear
      const found = body.find((c: Record<string, unknown>) => c.id === noProjectId);
      expect(found).toBeUndefined();
    });

    it('filters by no-projects — includes only customers without projects', async () => {
      // Create a customer with no projects
      const createRes = await authPost(ownerToken, '/api/customers', {
        name: 'Export NoProjects Control',
      });
      const noProjectId = createRes.json().id;

      const res = await authGet(ownerToken, '/api/export/customers?hasProjects=false');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.length).toBeGreaterThanOrEqual(1);

      // Our control customer (no projects) must appear
      const found = body.find((c: Record<string, unknown>) => c.id === noProjectId);
      expect(found).toBeDefined();
    });

    it('all authenticated users can export (worker has customer:read)', async () => {
      const res = await authGet(workerToken, '/api/export/customers');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
  });
});
