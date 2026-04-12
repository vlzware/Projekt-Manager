/**
 * API integration tests: Bulk customer import.
 *
 * Tests AT-35 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the API contract for bulk customer import introduced in iteration 6.
 * Follows the same partial-success pattern as project bulk import
 * (see projects-bulk.test.ts).
 *
 * Route convention:
 *   POST /api/customers/bulk/import → bulk import customers
 *
 * Spec §14.2.4 semantics:
 *   - Each item validated independently, never aborts on first invalid
 *   - Name matches existing customer → overwrite (counts as `updated`)
 *   - Result: { imported: number, updated: number, errors: { index, message }[] }
 *   - Requires customer:write permission
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authPost, authGet } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Bulk Customer Import (AT-35)', () => {
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
  // Authentication & Authorization
  // ---------------------------------------------------------------
  describe('Authentication & Authorization', () => {
    it('returns 401 when not authenticated', async () => {
      const { getApp } = await import('../../test/api-helpers.js');
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/customers/bulk/import',
        payload: { customers: [] },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when user lacks customer:write permission (worker)', async () => {
      const res = await authPost(workerToken, '/api/customers/bulk/import', {
        customers: [],
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('returns 200 for empty array when user has permission', async () => {
      const res = await authPost(ownerToken, '/api/customers/bulk/import', {
        customers: [],
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.updated).toBe(0);
      expect(body.errors).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  // Partial success — valid items persisted, invalid reported
  // ---------------------------------------------------------------
  describe('Partial success', () => {
    it('imports valid items and reports errors for invalid ones', async () => {
      const res = await authPost(ownerToken, '/api/customers/bulk/import', {
        customers: [
          { name: 'Bulk Kunde Eins' },
          { /* missing name — invalid */ phone: '0123' },
          {
            name: 'Bulk Kunde Drei',
            phone: '0221-5555555',
            email: 'drei@example.de',
          },
        ],
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.imported).toBe(2);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].index).toBe(1);
      expect(typeof body.errors[0].message).toBe('string');
      expect(body.errors[0].message.length).toBeGreaterThan(0);
    });

    it('imports customers with all optional fields', async () => {
      const res = await authPost(ownerToken, '/api/customers/bulk/import', {
        customers: [
          {
            name: 'Vollständiger Bulk-Kunde',
            phone: '0170-1234567',
            email: 'voll@example.de',
            address: { street: 'Teststr. 1', zip: '50667', city: 'Köln' },
            notes: 'Importiert via Bulk',
          },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().imported).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // Overwrite semantics — name match updates existing
  // ---------------------------------------------------------------
  describe('Overwrite semantics', () => {
    it('updates existing customer when name matches — counts as updated', async () => {
      // Create a customer first
      await authPost(ownerToken, '/api/customers', {
        name: 'Overwrite Target',
        phone: '0000-old',
      });

      // Import with the same name — should update, not create duplicate
      const res = await authPost(ownerToken, '/api/customers/bulk/import', {
        customers: [
          {
            name: 'Overwrite Target',
            phone: '0000-new',
            email: 'overwritten@example.de',
          },
        ],
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.imported).toBe(0); // Not a new record
      expect(body.updated).toBe(1); // Updated existing
      expect(body.errors).toEqual([]);

      // Verify the customer was updated, not duplicated
      const listRes = await authGet(ownerToken, '/api/customers?search=Overwrite Target');
      const matches = listRes.json().customers;
      expect(matches.length).toBe(1);
      expect(matches[0].phone).toBe('0000-new');
      expect(matches[0].email).toBe('overwritten@example.de');
    });
  });

  // ---------------------------------------------------------------
  // Validation errors
  // ---------------------------------------------------------------
  describe('Validation errors', () => {
    it('rejects items with empty-string name', async () => {
      const res = await authPost(ownerToken, '/api/customers/bulk/import', {
        customers: [{ name: '' }],
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------
  // Request validation
  // ---------------------------------------------------------------
  describe('Request validation', () => {
    it('rejects request without customers array', async () => {
      const res = await authPost(ownerToken, '/api/customers/bulk/import', {});

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
