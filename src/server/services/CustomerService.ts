/**
 * Customer service — business logic orchestration for customers.
 */

import type { Database } from '../db/connection.js';
import { eq, and } from 'drizzle-orm';
import {
  listCustomers as listCustomersRepo,
  getCustomer as getCustomerRepo,
  createCustomer as createCustomerRepo,
  updateCustomer as updateCustomerRepo,
  deleteCustomer as deleteCustomerRepo,
  getCustomerRow,
  toCustomerResponse,
  findCustomersByName,
} from '../repositories/customer.js';
import { projects } from '../db/schema.js';
import { DB_CONSTRAINTS } from '../db/constraints.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, conflict, idempotencyConflict, extractPgConstraint } from '../errors.js';
import { customerMatches } from './idempotency.js';
import type { ServiceLogger } from './Logger.js';

export class CustomerService {
  constructor(private db: Database) {}

  async listCustomers(opts: { offset?: number; limit?: number; search?: string }) {
    return listCustomersRepo(this.db, opts);
  }

  async getCustomer(id: string) {
    const customer = await getCustomerRepo(this.db, id);
    if (!customer) throw notFound(STRINGS.entities.customer);
    return customer;
  }

  async createCustomer(
    data: {
      id?: string;
      name: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
  ) {
    if (data.id !== undefined) {
      return this.createCustomerWithClientId(data, data.id, userId, log);
    }

    const customer = await createCustomerRepo(this.db, {
      ...data,
      createdBy: userId,
      updatedBy: userId,
    });
    log.info({ customerId: customer.id }, 'customer_created');
    return customer;
  }

  private async createCustomerWithClientId(
    data: {
      name: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
    id: string,
    userId: string,
    log: ServiceLogger,
  ) {
    // Pre-SELECT is best-effort — under READ COMMITTED a concurrent insert
    // can still slip between this lookup and the INSERT below. The 23505
    // catch block is the actual race handler.
    const existing = await getCustomerRow(this.db, id);
    if (existing) {
      if (!customerMatches(data, existing)) {
        throw idempotencyConflict();
      }
      log.info({ customerId: id }, 'customer_create_replayed');
      return toCustomerResponse(existing);
    }

    try {
      const inserted = await createCustomerRepo(this.db, {
        id,
        ...data,
        createdBy: userId,
        updatedBy: userId,
      });
      log.info({ customerId: id }, 'customer_created');
      return inserted;
    } catch (err) {
      // Re-read on any 23505: the committed row is authoritative. When the
      // driver omits `constraint`, a concurrent id clash is the only way a
      // second caller reaches this branch after the pre-select found
      // nothing, so the fallback re-read still does the right thing.
      const constraintName = extractPgConstraint(err);
      if (constraintName === DB_CONSTRAINTS.customers.pkey || constraintName === null) {
        const row = await getCustomerRow(this.db, id);
        if (row) {
          if (!customerMatches(data, row)) {
            throw idempotencyConflict();
          }
          log.info({ customerId: id }, 'customer_create_replayed');
          return toCustomerResponse(row);
        }
      }
      throw err;
    }
  }

  async updateCustomer(
    id: string,
    data: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
  ) {
    const customer = await updateCustomerRepo(this.db, id, userId, data);
    if (!customer) throw notFound(STRINGS.entities.customer);
    log.info({ customerId: id }, 'customer_updated');
    return customer;
  }

  async deleteCustomer(id: string, log: ServiceLogger) {
    // Check for active (non-archived) projects referencing this customer.
    const activeProjects = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.customerId, id), eq(projects.deleted, false)))
      .limit(1);

    if (activeProjects.length > 0) {
      throw conflict(STRINGS.customers.hasProjects);
    }

    // All referencing projects (if any) are archived. Delete them and the
    // customer atomically — the archive has no value without the customer.
    // project_workers rows cascade automatically (ON DELETE CASCADE).
    await this.db.transaction(async (tx) => {
      const purged = await tx
        .delete(projects)
        .where(and(eq(projects.customerId, id), eq(projects.deleted, true)))
        .returning({ id: projects.id });

      if (purged.length > 0) {
        log.info(
          { customerId: id, archivedProjectsRemoved: purged.length },
          'archived_projects_purged',
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deleted = await deleteCustomerRepo(tx as any, id);
      if (!deleted) throw notFound(STRINGS.entities.customer);
    });

    log.info({ customerId: id }, 'customer_deleted');
  }

  async bulkImport(
    items: {
      name?: unknown;
      phone?: unknown;
      email?: unknown;
      address?: unknown;
      notes?: unknown;
    }[],
    userId: string,
    log: ServiceLogger,
  ): Promise<{ imported: number; updated: number; errors: { index: number; message: string }[] }> {
    const errors: { index: number; message: string }[] = [];
    let imported = 0;
    let updated = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;

      if (typeof item.name !== 'string' || item.name.trim() === '') {
        errors.push({ index: i, message: STRINGS.customers.nameRequired });
        continue;
      }
      if (item.name.length > 255) {
        errors.push({ index: i, message: STRINGS.validation.maxLength('name', 255) });
        continue;
      }

      // Validate address structure if present — must have street, zip, city as strings
      let address: { street: string; zip: string; city: string } | null = null;
      if (item.address !== undefined && item.address !== null) {
        if (typeof item.address !== 'object' || Array.isArray(item.address)) {
          errors.push({ index: i, message: STRINGS.validation.mustBeObject('address') });
          continue;
        }
        const addr = item.address as Record<string, unknown>;
        if (
          typeof addr.street !== 'string' ||
          typeof addr.zip !== 'string' ||
          typeof addr.city !== 'string'
        ) {
          errors.push({
            index: i,
            message: STRINGS.validation.mustBeObject('address (street, zip, city)'),
          });
          continue;
        }
        address = { street: addr.street, zip: addr.zip, city: addr.city };
      }

      const data = {
        name: item.name,
        phone: typeof item.phone === 'string' ? item.phone : null,
        email: typeof item.email === 'string' ? item.email : null,
        address,
        notes: typeof item.notes === 'string' ? item.notes : null,
      };

      try {
        const matches = await findCustomersByName(this.db, data.name);
        if (matches.length > 1) {
          // Ambiguous: multiple customers share this name — refuse to guess
          errors.push({ index: i, message: STRINGS.customers.ambiguousName });
          continue;
        }
        if (matches.length === 1) {
          await updateCustomerRepo(this.db, matches[0]!.id, userId, data);
          updated++;
        } else {
          await createCustomerRepo(this.db, {
            ...data,
            createdBy: userId,
            updatedBy: userId,
          });
          imported++;
        }
      } catch (err) {
        log.error({ err, index: i }, 'Customer bulk import row failed');
        errors.push({ index: i, message: STRINGS.errors.mutationFailed });
      }
    }

    return { imported, updated, errors };
  }
}
