/**
 * Unified business-data export. See ADR-0018 and data-model.md §5.8.
 */

import { asc } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { customers, projects, projectWorkers } from '../db/schema.js';
import { SCHEMA_VERSION, type Envelope } from './dataExchangeEnvelope.js';
import { toCustomerResponse } from '../repositories/customer.js';
import { formatDateOnly } from '../../domain/dateFormat.js';
import type { WorkflowState } from '../../config/stateConfig.js';

export class ExportService {
  constructor(private db: Database) {}

  /**
   * Export every row of the business-data layer as a single envelope.
   * Deterministic ordering across all three tables so AT-77 can byte-compare
   * successive exports after a roundtrip.
   */
  async export(): Promise<Envelope> {
    const { customerRows, projectRows, assignmentRows } = await this.db.transaction(
      async (tx) => {
        // Sequential — drizzle runs each tx query on the same pg client, so
        // Promise.all here would trigger pg's "concurrent query" deprecation
        // warning without any real parallelism.
        const customerRows = await tx.select().from(customers).orderBy(asc(customers.id));
        const projectRows = await tx.select().from(projects).orderBy(asc(projects.id));
        const assignmentRows = await tx
          .select()
          .from(projectWorkers)
          .orderBy(asc(projectWorkers.projectId), asc(projectWorkers.userId));
        return { customerRows, projectRows, assignmentRows };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    return {
      schema_version: SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      customers: customerRows.map(toCustomerResponse),
      projects: projectRows.map((p) => ({
        id: p.id,
        number: p.number,
        title: p.title,
        status: p.status as WorkflowState,
        statusChangedAt: p.statusChangedAt.toISOString(),
        customerId: p.customerId,
        plannedStart: p.plannedStart ? formatDateOnly(p.plannedStart) : null,
        plannedEnd: p.plannedEnd ? formatDateOnly(p.plannedEnd) : null,
        estimatedValue: p.estimatedValue,
        notes: p.notes,
        deleted: p.deleted,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        createdBy: p.createdBy,
        updatedBy: p.updatedBy,
      })),
      project_workers: assignmentRows.map((a) => ({
        projectId: a.projectId,
        userId: a.userId,
      })),
    };
  }
}
