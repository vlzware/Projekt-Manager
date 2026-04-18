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
} from '../repositories/customer.js';
import { projects } from '../db/schema.js';
import { DB_CONSTRAINTS } from '../db/constraints.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, notPermitted, conflict } from '../errors.js';
import { customerMatches, createIdempotent } from './idempotency.js';
import type { ServiceLogger } from './Logger.js';
import type { AuthUser } from '../middleware/auth.js';
import { isOutOfScope } from '../repositories/scope.js';

export class CustomerService {
  constructor(private db: Database) {}

  async listCustomers(
    caller: AuthUser,
    opts: { offset?: number; limit?: number; search?: string },
  ) {
    return listCustomersRepo(this.db, caller, opts);
  }

  async getCustomer(caller: AuthUser, id: string) {
    const result = await getCustomerRepo(this.db, caller, id);
    if (result === null) throw notFound(STRINGS.entities.customer);
    // AC-148: out-of-scope → 403 NOT_PERMITTED, not 404.
    if (isOutOfScope(result)) throw notPermitted();
    return result;
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
    return createIdempotent({
      preSelectRow: () => getCustomerRow(this.db, id),
      replayFromRow: async (row) => {
        if (!customerMatches(data, row)) return null;
        log.info({ customerId: id }, 'customer_create_replayed');
        return toCustomerResponse(row);
      },
      insert: async () => {
        const inserted = await createCustomerRepo(this.db, {
          id,
          ...data,
          createdBy: userId,
          updatedBy: userId,
        });
        log.info({ customerId: id }, 'customer_created');
        return inserted;
      },
      isIdRaceConstraint: (c) => c === DB_CONSTRAINTS.customers.pkey || c === null,
      // Customers have no other unique constraint — a 23505 the helper can't
      // resolve as id-race is genuinely unexpected. Rethrow untouched.
      onNonIdRaceConstraint: (err) => {
        throw err;
      },
    });
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

      const deleted = await deleteCustomerRepo(tx, id);
      if (!deleted) throw notFound(STRINGS.entities.customer);
    });

    log.info({ customerId: id }, 'customer_deleted');
  }
}
