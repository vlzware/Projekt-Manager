/**
 * Customer service — business logic orchestration for customers.
 */

import type { Database } from '../db/connection.js';
import {
  listCustomers as listCustomersRepo,
  getCustomer as getCustomerRepo,
  createCustomer as createCustomerRepo,
  updateCustomer as updateCustomerRepo,
  deleteCustomer as deleteCustomerRepo,
  findCustomerByName,
} from '../repositories/customer.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, conflict, extractSqlState } from '../errors.js';
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
      name: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
  ) {
    const customer = await createCustomerRepo(this.db, {
      ...data,
      createdBy: userId,
      updatedBy: userId,
    });
    log.info({ customerId: customer.id }, 'customer_created');
    return customer;
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
    try {
      const deleted = await deleteCustomerRepo(this.db, id);
      if (!deleted) throw notFound(STRINGS.entities.customer);
      log.info({ customerId: id }, 'customer_deleted');
    } catch (err) {
      if (extractSqlState(err) === '23503') {
        throw conflict(STRINGS.customers.hasProjects);
      }
      throw err;
    }
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
        const existing = await findCustomerByName(this.db, data.name);
        if (existing) {
          await updateCustomerRepo(this.db, existing.id, userId, data);
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
