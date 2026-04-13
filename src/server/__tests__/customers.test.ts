/**
 * API integration tests: Customer CRUD operations.
 *
 * Tests AT-23 to AT-26 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the API contract for the customers entity introduced in iteration 6.
 *
 * Route conventions (inferred from existing patterns):
 *   GET    /api/customers           → list customers (with search, pagination)
 *   GET    /api/customers/:id       → get single customer (with project count)
 *   POST   /api/customers           → create customer
 *   PATCH  /api/customers/:id       → update customer (PATCH semantics)
 *
 * Permission model:
 *   - All authenticated users can read customers (customer:read)
 *   - owner and office can create/update (customer:write)
 *   - No delete operation — customers are permanent (spec §8.9)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost, authPatch } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Customer CRUD Operations', () => {
  let ownerToken: string;
  let workerToken: string;

  /** ID of a customer created in AT-23, used by subsequent tests. */
  let createdCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-23: Create customer with a name → generated ID
  // ---------------------------------------------------------------
  describe('AT-23: Create customer', () => {
    it('returns 201 with a customer object containing a generated ID', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        name: 'Familie Testmann',
      });

      expect(res.statusCode).toBe(201);

      const customer = res.json();
      expect(customer.id).toBeDefined();
      expect(typeof customer.id).toBe('string');
      expect(customer.name).toBe('Familie Testmann');
      expect(customer.createdAt).toBeDefined();
      expect(customer.updatedAt).toBeDefined();

      createdCustomerId = customer.id;
    });

    it('accepts all optional fields', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        name: 'Schmidt GmbH Test',
        phone: '0221-1234567',
        email: 'kontakt@schmidt-test.de',
        address: {
          street: 'Industriestr. 42',
          zip: '50667',
          city: 'Köln',
        },
        notes: 'Bestandskunde seit 2020',
      });

      expect(res.statusCode).toBe(201);

      const customer = res.json();
      expect(customer.name).toBe('Schmidt GmbH Test');
      expect(customer.phone).toBe('0221-1234567');
      expect(customer.email).toBe('kontakt@schmidt-test.de');
      expect(customer.address).toEqual({
        street: 'Industriestr. 42',
        zip: '50667',
        city: 'Köln',
      });
      expect(customer.notes).toBe('Bestandskunde seit 2020');
    });

    it('defaults optional fields to null', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        name: 'Minimal Kunde',
      });

      expect(res.statusCode).toBe(201);

      const customer = res.json();
      expect(customer.phone).toBeNull();
      expect(customer.email).toBeNull();
      expect(customer.address).toBeNull();
      expect(customer.notes).toBeNull();
    });

    it('requires name — rejects when missing', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        phone: '0221-0000000',
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('requires customer:write permission — worker is rejected', async () => {
      const res = await authPost(workerToken, '/api/customers', {
        name: 'Worker Should Not Create',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // ---------------------------------------------------------------
  // AT-24: Update customer — PATCH semantics
  // AC-55 [crit]
  // ---------------------------------------------------------------
  describe('AT-24: Update customer (PATCH semantics)', () => {
    it('changes only the specified fields, preserves others', async () => {
      // Read before state
      const beforeRes = await authGet(ownerToken, `/api/customers/${createdCustomerId}`);
      expect(beforeRes.statusCode).toBe(200);

      const res = await authPatch(ownerToken, `/api/customers/${createdCustomerId}`, {
        phone: '0170-9876543',
      });

      expect(res.statusCode).toBe(200);

      const after = res.json();
      // Changed
      expect(after.phone).toBe('0170-9876543');
      // Preserved
      expect(after.name).toBe('Familie Testmann');

      // Audit field updated
      expect(after.updatedAt).toBeDefined();
    });

    it('clears an optional field when set to null', async () => {
      // First set a phone number
      await authPatch(ownerToken, `/api/customers/${createdCustomerId}`, {
        email: 'test@example.de',
      });

      // Then clear it
      const res = await authPatch(ownerToken, `/api/customers/${createdCustomerId}`, {
        email: null,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBeNull();
    });

    it('requires customer:write permission — worker is rejected', async () => {
      const res = await authPatch(workerToken, `/api/customers/${createdCustomerId}`, {
        phone: '0170-0000000',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // ---------------------------------------------------------------
  // AT-25: List customers with search parameter
  // AC-56 [crit]
  // ---------------------------------------------------------------
  describe('AT-25: List customers', () => {
    it('returns all customers with pagination', async () => {
      const res = await authGet(ownerToken, '/api/customers');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.customers).toBeDefined();
      expect(Array.isArray(body.customers)).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('respects limit and offset parameters', async () => {
      const res = await authGet(ownerToken, '/api/customers?limit=2&offset=0');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.customers.length).toBeLessThanOrEqual(2);
    });

    it('filters by name substring (case-insensitive)', async () => {
      const res = await authGet(ownerToken, '/api/customers?search=testmann');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.customers.length).toBeGreaterThanOrEqual(1);

      for (const customer of body.customers) {
        expect(customer.name.toLowerCase()).toContain('testmann');
      }
    });

    it('returns empty array when search has no match', async () => {
      const res = await authGet(ownerToken, '/api/customers?search=DefinitelyNoMatchXYZ123');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.customers).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('all authenticated users can read (worker included)', async () => {
      const res = await authGet(workerToken, '/api/customers');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().customers)).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // AT-26: Get customer includes project count
  // AC-57 [crit]
  // ---------------------------------------------------------------
  describe('AT-26: Get single customer with project count', () => {
    it('returns the full customer object and associated project count', async () => {
      const res = await authGet(ownerToken, `/api/customers/${createdCustomerId}`);

      expect(res.statusCode).toBe(200);

      const customer = res.json();
      expect(customer.id).toBe(createdCustomerId);
      expect(customer.name).toBe('Familie Testmann');
      expect(typeof customer.projectCount).toBe('number');
      expect(customer.projectCount).toBeGreaterThanOrEqual(0);
    });

    it('returns 404 for non-existent customer', async () => {
      const res = await authGet(ownerToken, '/api/customers/00000000-0000-0000-0000-000000000000');

      expect(res.statusCode).toBe(404);

      const body = res.json();
      expect(body.code).toBe('NOT_FOUND');
    });
  });
});
