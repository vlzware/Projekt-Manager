/**
 * Customer service — business logic orchestration for customers.
 */

import type { Database } from '../db/connection.js';
import {
  listCustomers as listCustomersRepo,
  getCustomer as getCustomerRepo,
  createCustomer as createCustomerRepo,
  updateCustomer as updateCustomerRepo,
  findCustomerByName,
} from '../repositories/customer.js';
import { STRINGS } from '../../config/strings.js';
import { notFound } from '../errors.js';
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

      const data = {
        name: item.name,
        phone: typeof item.phone === 'string' ? item.phone : null,
        email: typeof item.email === 'string' ? item.email : null,
        address:
          item.address && typeof item.address === 'object' && !Array.isArray(item.address)
            ? (item.address as { street: string; zip: string; city: string })
            : null,
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
