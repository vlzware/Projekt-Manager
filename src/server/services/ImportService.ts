/**
 * Unified business-data restore. See ADR-0018 and data-model.md §5.8.
 *
 * Empty target → proceed; non-empty target → refuse unless the caller sets
 * `override`, which wipes customers/projects/project_workers in the same
 * transaction. IDs are preserved; dry-run validates without writes.
 */

import { sql } from 'drizzle-orm';
import { customers, projects, projectWorkers } from '../db/schema.js';
import type { Database } from '../db/connection.js';
import { schemaVersionMismatch, targetNotEmpty, validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import {
  SCHEMA_VERSION,
  type Envelope,
  type EnvelopeCustomer,
  type EnvelopeProject,
  type EnvelopeAssignment,
  type ImportOptions,
  type ImportResult,
  type DryRunPreview,
  type ValidationIssue,
} from '../../domain/dataExchange.js';

/**
 * Within-envelope structural checks — uniqueness of keys that become DB
 * constraints on insert, plus referential integrity between tables. Row-level
 * column validation is left to the DB. This pre-check exists so dry-run
 * reports issues without writes, and so non-dry-run fails cleanly (422)
 * before TRUNCATE rather than bubbling a 23505 through as a generic 500.
 */
function validateEnvelope(envelope: Envelope): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Uniqueness: customer id (pkey)
  const customerIds = new Set<string>();
  for (let i = 0; i < envelope.customers.length; i++) {
    const c = envelope.customers[i]!;
    if (customerIds.has(c.id)) {
      issues.push({
        path: `customers[${i}].id`,
        message: `duplicate customer id ${c.id} within envelope`,
      });
    }
    customerIds.add(c.id);
  }

  // Uniqueness: project id (pkey) and project number (unique)
  const projectIds = new Set<string>();
  const projectNumbers = new Set<string>();
  for (let i = 0; i < envelope.projects.length; i++) {
    const p = envelope.projects[i]!;
    if (projectIds.has(p.id)) {
      issues.push({
        path: `projects[${i}].id`,
        message: `duplicate project id ${p.id} within envelope`,
      });
    }
    projectIds.add(p.id);
    if (projectNumbers.has(p.number)) {
      issues.push({
        path: `projects[${i}].number`,
        message: `duplicate project number ${p.number} within envelope`,
      });
    }
    projectNumbers.add(p.number);
  }

  // Uniqueness: project_workers composite (projectId, userId)
  const assignmentKeys = new Set<string>();
  for (let i = 0; i < envelope.project_workers.length; i++) {
    const pw = envelope.project_workers[i]!;
    const key = `${pw.projectId}|${pw.userId}`;
    if (assignmentKeys.has(key)) {
      issues.push({
        path: `project_workers[${i}]`,
        message: `duplicate project_worker assignment (projectId=${pw.projectId}, userId=${pw.userId}) within envelope`,
      });
    }
    assignmentKeys.add(key);
  }

  // Referential integrity: project→customer, assignment→project
  for (let i = 0; i < envelope.projects.length; i++) {
    const p = envelope.projects[i]!;
    if (!customerIds.has(p.customerId)) {
      issues.push({
        path: `projects[${i}].customerId`,
        message: `customerId ${p.customerId} not present in envelope.customers`,
      });
    }
  }

  for (let i = 0; i < envelope.project_workers.length; i++) {
    const pw = envelope.project_workers[i]!;
    if (!projectIds.has(pw.projectId)) {
      issues.push({
        path: `project_workers[${i}].projectId`,
        message: `projectId ${pw.projectId} not present in envelope.projects`,
      });
    }
  }

  return issues;
}

function toCustomerInsert(c: EnvelopeCustomer) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    address: c.address,
    notes: c.notes,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
    createdBy: c.createdBy,
    updatedBy: c.updatedBy,
  };
}

function toProjectInsert(p: EnvelopeProject) {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    status: p.status,
    statusChangedAt: new Date(p.statusChangedAt),
    customerId: p.customerId,
    plannedStart: p.plannedStart ? new Date(p.plannedStart) : null,
    plannedEnd: p.plannedEnd ? new Date(p.plannedEnd) : null,
    estimatedValue: p.estimatedValue,
    notes: p.notes,
    deleted: p.deleted,
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
    createdBy: p.createdBy,
    updatedBy: p.updatedBy,
  };
}

function toAssignmentInsert(pw: EnvelopeAssignment) {
  return { projectId: pw.projectId, userId: pw.userId };
}

export class ImportService {
  constructor(private db: Database) {}

  async import(envelope: Envelope, opts: ImportOptions): Promise<ImportResult | DryRunPreview> {
    if (envelope.schema_version !== SCHEMA_VERSION) {
      throw schemaVersionMismatch(SCHEMA_VERSION, envelope.schema_version);
    }

    const validationIssues = validateEnvelope(envelope);

    if (opts.dryRun) {
      // Read-only snapshot matches the ExportService pattern — the preview
      // answers "what would happen if I committed right now", and a
      // repeatable-read read-only transaction is the closest match to that
      // semantic without contending with concurrent writers.
      const targetNonEmpty = await this.db.transaction(
        async (tx) => {
          const presenceResult = await tx.execute<{ present: boolean }>(
            sql`SELECT (
              EXISTS (SELECT 1 FROM customers)
              OR EXISTS (SELECT 1 FROM projects)
              OR EXISTS (SELECT 1 FROM project_workers)
            ) AS present`,
          );
          return presenceResult.rows[0]?.present === true;
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );

      return {
        schema_version: SCHEMA_VERSION,
        target_non_empty: targetNonEmpty,
        would_write: {
          customers: envelope.customers.length,
          projects: envelope.projects.length,
          project_workers: envelope.project_workers.length,
        },
        validation_errors: validationIssues,
      };
    }

    if (validationIssues.length > 0) {
      throw validationError(STRINGS.errors.invalidInput, validationIssues);
    }

    // Pre-map before opening the tx — pure transformation, no reason to hold
    // a write lock while building the row objects.
    const customerRows = envelope.customers.map(toCustomerInsert);
    const projectRows = envelope.projects.map(toProjectInsert);
    const assignmentRows = envelope.project_workers.map(toAssignmentInsert);

    await this.db.transaction(async (tx) => {
      // VPN-first deployment (ADR-0008) rules out concurrent restores in
      // practice, so the default READ COMMITTED isolation is sufficient —
      // TRUNCATE takes ACCESS EXCLUSIVE anyway.
      const presenceResult = await tx.execute<{ present: boolean }>(
        sql`SELECT (
          EXISTS (SELECT 1 FROM customers)
          OR EXISTS (SELECT 1 FROM projects)
          OR EXISTS (SELECT 1 FROM project_workers)
        ) AS present`,
      );
      const hasExisting = presenceResult.rows[0]?.present === true;

      if (hasExisting && !opts.override) {
        throw targetNotEmpty();
      }

      if (opts.override) {
        await tx.execute(
          sql`TRUNCATE TABLE project_workers, projects, customers RESTART IDENTITY CASCADE`,
        );
      }

      if (customerRows.length > 0) {
        await tx.insert(customers).values(customerRows);
      }
      if (projectRows.length > 0) {
        await tx.insert(projects).values(projectRows);
      }
      if (assignmentRows.length > 0) {
        await tx.insert(projectWorkers).values(assignmentRows);
      }
    });

    return {
      schema_version: SCHEMA_VERSION,
      summary: {
        customers: envelope.customers.length,
        projects: envelope.projects.length,
        project_workers: envelope.project_workers.length,
      },
    };
  }
}
