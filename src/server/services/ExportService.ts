/**
 * Export service — business logic for project and customer data export.
 */

import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { projects, customers } from '../db/schema.js';
import { toProject, fetchWorkersForProjects } from '../repositories/project-read.js';
import { toCustomerResponse } from '../repositories/customer.js';

export class ExportService {
  constructor(private db: Database) {}

  async exportProjects(filters?: { status?: string | string[]; customerId?: string }) {
    const conditions = [eq(projects.deleted, false)];

    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      if (statuses.length === 1) {
        conditions.push(eq(projects.status, statuses[0]!));
      } else if (statuses.length > 1) {
        conditions.push(inArray(projects.status, statuses));
      }
    }

    if (filters?.customerId) {
      conditions.push(eq(projects.customerId, filters.customerId));
    }

    const rows = await this.db
      .select()
      .from(projects)
      .where(and(...conditions));

    const customerIds = [...new Set(rows.map((r) => r.customerId))];
    const customerRows =
      customerIds.length > 0
        ? await this.db.select().from(customers).where(inArray(customers.id, customerIds))
        : [];
    const customerMap = new Map(customerRows.map((c) => [c.id, c]));

    const workerMap = await fetchWorkersForProjects(
      this.db,
      rows.map((r) => r.id),
    );
    return rows.map((r) =>
      toProject(r, customerMap.get(r.customerId) ?? null, workerMap.get(r.id) ?? []),
    );
  }

  async exportCustomers(filters?: { hasProjects?: string }) {
    let rows = await this.db.select().from(customers);

    if (filters?.hasProjects === 'true' || filters?.hasProjects === 'false') {
      const projectCustomerIds = await this.db
        .select({ customerId: projects.customerId })
        .from(projects)
        .where(eq(projects.deleted, false))
        .groupBy(projects.customerId);

      const idsWithProjects = new Set(projectCustomerIds.map((r) => r.customerId));

      if (filters.hasProjects === 'true') {
        rows = rows.filter((c) => idsWithProjects.has(c.id));
      } else {
        rows = rows.filter((c) => !idsWithProjects.has(c.id));
      }
    }

    return rows.map(toCustomerResponse);
  }
}
