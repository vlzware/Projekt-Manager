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
} from './dataExchangeEnvelope.js';

export type { Envelope as ImportEnvelope } from './dataExchangeEnvelope.js';

export interface ImportOptions {
  dryRun: boolean;
  override: boolean;
}

export interface ImportResult {
  schema_version: number;
  summary: {
    customers: number;
    projects: number;
    project_workers: number;
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface DryRunPreview {
  schema_version: number;
  /**
   * True when at least one of customers / projects / project_workers has
   * rows in the target at dry-run time. Lets the UI decide whether to
   * require the override-warning acknowledgement before allowing commit.
   * Computed inside a read-only repeatable-read transaction to match the
   * Export path's snapshot semantics; the non-dry commit path still
   * enforces `TARGET_NOT_EMPTY` when override is not set (defense in
   * depth).
   */
  target_non_empty: boolean;
  would_write: {
    customers: number;
    projects: number;
    project_workers: number;
  };
  validation_errors: ValidationIssue[];
}

/**
 * Within-envelope referential integrity — every project's `customerId`
 * resolves to an envelope customer; every `project_worker.projectId` resolves
 * to an envelope project. Row-level column validation is left to the DB
 * constraints on insert. This pre-check exists so dry-run reports structural
 * issues without writes, and so non-dry-run fails cleanly before TRUNCATE.
 */
function validateEnvelopeReferences(envelope: Envelope): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const customerIds = new Set(envelope.customers.map((c) => c.id));
  const projectIds = new Set(envelope.projects.map((p) => p.id));

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

    const validationIssues = validateEnvelopeReferences(envelope);

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
