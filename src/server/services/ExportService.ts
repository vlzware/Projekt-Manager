/**
 * Export service — business logic for project and customer data export.
 */

import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '../db/connection.js';

/**
 * Drizzle transactions have the same query-builder API as the full Database
 * but lack the $client property. This helper narrows the export's tx to
 * the Database type expected by fetchWorkersForProjects, which only uses
 * the query-builder surface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryRunner = any;
import { projects, customers } from '../db/schema.js';
import { toProject, fetchWorkersForProjects } from '../repositories/project-read.js';
import { toCustomerResponse } from '../repositories/customer.js';

export class ExportService {
  constructor(private db: Database) {}

  /**
   * Export projects as a consistent snapshot.
   * Uses REPEATABLE READ so all queries see the same database state.
   */
  async exportProjects(filters?: { status?: string | string[]; customerId?: string }) {
    return this.db.transaction(
      async (tx) => {
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

        const rows = await tx
          .select()
          .from(projects)
          .where(and(...conditions));

        const customerIds = [...new Set(rows.map((r) => r.customerId))];
        const customerRows =
          customerIds.length > 0
            ? await tx.select().from(customers).where(inArray(customers.id, customerIds))
            : [];
        const customerMap = new Map(customerRows.map((c) => [c.id, c]));

        const workerMap = await fetchWorkersForProjects(
          tx as QueryRunner,
          rows.map((r) => r.id),
        );
        return rows.map((r) =>
          toProject(r, customerMap.get(r.customerId) ?? null, workerMap.get(r.id) ?? []),
        );
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * Export customers as a consistent snapshot.
   * Uses REPEATABLE READ so all queries see the same database state.
   */
  async exportCustomers(filters?: { hasProjects?: string }) {
    return this.db.transaction(
      async (tx) => {
        let rows = await tx.select().from(customers);

        if (filters?.hasProjects === 'true' || filters?.hasProjects === 'false') {
          const projectCustomerIds = await tx
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
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
