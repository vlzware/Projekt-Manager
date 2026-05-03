/**
 * Unified business-data export. See ADR-0018 and data-model.md §5.8.
 */

import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { attachments, customers, projects, projectWorkers } from '../db/schema.js';
import { SCHEMA_VERSION, type Envelope } from '../../domain/dataExchange.js';
import { toCustomerResponse } from '../repositories/customer.js';
import { isUnscoped } from '../repositories/scope.js';
import type { AuthUser } from '../middleware/auth.js';
import { formatDateOnly } from '../../domain/dateFormat.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import type { AttachmentKind, AttachmentLabel } from '../../domain/types.js';

export class ExportService {
  constructor(private db: Database) {}

  /**
   * Export every row of the business-data layer as a single envelope.
   * Deterministic ordering across all three tables so AT-77 can byte-compare
   * successive exports after a roundtrip.
   *
   * The caller is threaded through as a fail-fast tripwire: this service
   * deliberately bypasses the per-caller scope seam (ADR-0019) because an
   * export is, by definition, the whole dataset. Today only owner/office
   * hold `data:export`, but if a scoped role ever gains it via permission
   * churn, this assertion fires before any row leaks. See ADR-0019
   * "Alternatives considered" for why scope is enforced at the seam rather
   * than in the permission check.
   */
  async export(caller: AuthUser): Promise<Envelope> {
    if (!isUnscoped(caller)) {
      throw new Error(
        `ExportService.export must be invoked with an unscoped caller; got roles=[${caller.roles.join(', ')}]`,
      );
    }

    const { customerRows, projectRows, assignmentRows, attachmentRows } = await this.db.transaction(
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
        // AC-220: only ready rows travel in the envelope. Pending rows
        // represent uncommitted uploads and are excluded by design.
        const attachmentRows = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.status, 'ready'))
          .orderBy(asc(attachments.id));
        return { customerRows, projectRows, assignmentRows, attachmentRows };
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
      attachments: attachmentRows.map((a) => ({
        id: a.id,
        projectId: a.projectId,
        status: 'ready' as const,
        kind: a.kind as AttachmentKind,
        label: a.label as AttachmentLabel,
        fileName: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        // ADR-0024: ciphertext sizes + wrapped envelopes + format
        // discriminator ride the export envelope so attachments
        // restore decryptable post-import (AC-220). Schema CHECK
        // guarantees both fields are populated on every `ready` row,
        // so the `??` collapse is structural — guards a pre-Phase-1
        // row where the column hasn't been backfilled.
        ciphertextSizeBytes: a.ciphertextSizeBytes ?? a.sizeBytes,
        ciphertextThumbSizeBytes: a.ciphertextThumbSizeBytes,
        originalKey: a.originalKey,
        thumbKey: a.thumbKey,
        hasThumbnail: a.hasThumbnail,
        wrappedDek: a.wrappedDek ?? '',
        wrappedThumbDek: a.wrappedThumbDek,
        // Envelope-format version (ADR-0024). NOT NULL on the row, so
        // no fallback needed — the column is always populated under
        // the current schema. Carrying it on the export envelope lets
        // the import path validate the discriminator before insert.
        wrappedDekVersion: a.wrappedDekVersion,
        createdAt: a.createdAt.toISOString(),
        createdBy: a.createdBy,
      })),
    };
  }
}
