/**
 * Unified business-data restore. See ADR-0018 and data-model.md §5.8.
 *
 * Empty target → proceed; non-empty target → refuse unless the caller sets
 * `override`, which wipes customers/projects/project_workers in the same
 * transaction. IDs are preserved; dry-run validates without writes.
 */

import { inArray, sql } from 'drizzle-orm';
import { customers, projects, projectWorkers, users } from '../db/schema.js';
import type { Database, TransactionalDatabase } from '../db/connection.js';
import {
  missingUserRefs,
  restoreConfirmationMismatch,
  schemaVersionMismatch,
  targetNotEmpty,
  validationError,
} from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { restorePhraseMatches } from '../../config/dataExchangeConfig.js';
import {
  SCHEMA_VERSION,
  type Envelope,
  type EnvelopeCustomer,
  type EnvelopeProject,
  type EnvelopeAssignment,
  type ImportOptions,
  type ImportResult,
  type DryRunPreview,
  type MissingUserReference,
  type MissingUserRefsPayload,
  type ValidationIssue,
} from '../../domain/dataExchange.js';
import { listAllKeys } from '../repositories/attachment.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { bestEffortHideStorageKeys } from './AttachmentService.js';
import type { ServiceLogger } from './Logger.js';
import { emitProjectChanged } from '../sse/emitters.js';

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

  // Issue #163: `/api/import` is text-only post-fix. The envelope
  // body MUST NOT carry an `attachments` key (rejected at the route
  // layer with 422 VALIDATION_ERROR — see api.md §14.2.4 and
  // AC-253). Per-attachment restoration runs through the standard
  // `init` (with `restore` block) + per-blob PUT + `complete`
  // pipeline against the importing instance (AC-256), driven by the
  // client orchestrator.

  return issues;
}

/**
 * Collect every envelope reference site whose user-id field must resolve
 * against the target's `users` table. Null / missing audit-field values
 * are skipped — they carry no reference, per api.md §14.2.4 and AC-162a.
 * `project_workers[].userId` is non-nullable by schema so it is always a
 * reference. Pure; unit-testable without a DB.
 */
function collectEnvelopeUserRefs(envelope: Envelope): MissingUserReference[] {
  const refs: MissingUserReference[] = [];

  for (let i = 0; i < envelope.customers.length; i++) {
    const c = envelope.customers[i]!;
    if (c.createdBy !== null && c.createdBy !== undefined) {
      refs.push({ path: `customers[${i}].createdBy`, userId: c.createdBy });
    }
    if (c.updatedBy !== null && c.updatedBy !== undefined) {
      refs.push({ path: `customers[${i}].updatedBy`, userId: c.updatedBy });
    }
  }

  for (let i = 0; i < envelope.projects.length; i++) {
    const p = envelope.projects[i]!;
    if (p.createdBy !== null && p.createdBy !== undefined) {
      refs.push({ path: `projects[${i}].createdBy`, userId: p.createdBy });
    }
    if (p.updatedBy !== null && p.updatedBy !== undefined) {
      refs.push({ path: `projects[${i}].updatedBy`, userId: p.updatedBy });
    }
  }

  for (let i = 0; i < envelope.project_workers.length; i++) {
    const pw = envelope.project_workers[i]!;
    refs.push({ path: `project_workers[${i}].userId`, userId: pw.userId });
  }

  return refs;
}

/**
 * From a collected reference list and a set of user ids known to exist in
 * the target, compute the `MISSING_USER_REFS` payload. Returns `null` when
 * every reference resolves — callers use that to skip raising the error
 * and to omit the sibling field from the dry-run preview.
 *
 * `missingUserIds` is deduplicated (insertion-ordered); `references`
 * retains one entry per offending site (duplicates across distinct paths
 * produce distinct entries — per api.md §14.4.1).
 */
function deriveMissingUserRefsPayload(
  refs: MissingUserReference[],
  presentIds: Set<string>,
): MissingUserRefsPayload | null {
  const offending = refs.filter((r) => !presentIds.has(r.userId));
  if (offending.length === 0) return null;

  const missingIds: string[] = [];
  const seen = new Set<string>();
  for (const r of offending) {
    if (!seen.has(r.userId)) {
      seen.add(r.userId);
      missingIds.push(r.userId);
    }
  }
  return { missingUserIds: missingIds, references: offending };
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
  /**
   * The optional `storage` client is required only for the override
   * path — `import()` throws if a non-empty target is wiped without one.
   * Empty-target imports (the seed path) construct without it.
   */
  constructor(
    private db: Database,
    private storage: AttachmentStorageClient | null = null,
  ) {}

  /**
   * One round-trip to the target `users` table resolves every referenced
   * user id at once — `WHERE id = ANY(...)` is N+1-free and matches the
   * Drizzle helper `inArray`. Empty input short-circuits without a query.
   */
  private async fetchPresentUserIds(
    runner: TransactionalDatabase,
    ids: string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await runner.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    return new Set(rows.map((r) => r.id));
  }

  async import(
    envelope: Envelope,
    opts: ImportOptions,
    log?: ServiceLogger,
  ): Promise<ImportResult | DryRunPreview> {
    if (envelope.schema_version !== SCHEMA_VERSION) {
      throw schemaVersionMismatch(SCHEMA_VERSION, envelope.schema_version);
    }

    const validationIssues = validateEnvelope(envelope);
    const userRefs = collectEnvelopeUserRefs(envelope);
    const uniqueReferencedIds = Array.from(new Set(userRefs.map((r) => r.userId)));

    if (opts.dryRun) {
      // Read-only snapshot matches the ExportService pattern — the preview
      // answers "what would happen if I committed right now", and a
      // repeatable-read read-only transaction is the closest match to that
      // semantic without contending with concurrent writers.
      const { targetNonEmpty, missingUserPayload } = await this.db.transaction(
        async (tx) => {
          const presenceResult = await tx.execute<{ present: boolean }>(
            sql`SELECT (
              EXISTS (SELECT 1 FROM customers)
              OR EXISTS (SELECT 1 FROM projects)
              OR EXISTS (SELECT 1 FROM project_workers)
              OR EXISTS (SELECT 1 FROM attachments)
            ) AS present`,
          );
          const presentIds = await this.fetchPresentUserIds(tx, uniqueReferencedIds);
          return {
            targetNonEmpty: presenceResult.rows[0]?.present === true,
            missingUserPayload: deriveMissingUserRefsPayload(userRefs, presentIds),
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );

      // AC-162b: on the dry-run path both classes are evaluated regardless
      // of intra-envelope state. `validation_errors` continues to carry
      // intra-envelope issues only; missing-user issues surface under the
      // sibling `missing_user_refs` field. api.md §14.2.4 deliberately
      // does not mint a wire-field name for the preview surface — we
      // mirror the commit-path `details` shape so a future UI can render
      // one component for both paths.
      return {
        schema_version: SCHEMA_VERSION,
        target_non_empty: targetNonEmpty,
        would_write: {
          customers: envelope.customers.length,
          projects: envelope.projects.length,
          project_workers: envelope.project_workers.length,
        },
        validation_errors: validationIssues,
        missing_user_refs: missingUserPayload,
      };
    }

    // AC-162c: commit-path ordering. Intra-envelope integrity is reported
    // first; the missing-user check runs only on an intra-consistent
    // envelope. Never both codes in one response.
    if (validationIssues.length > 0) {
      throw validationError(STRINGS.errors.invalidInput, validationIssues);
    }

    const presentUserIds = await this.fetchPresentUserIds(this.db, uniqueReferencedIds);
    const missingUserPayload = deriveMissingUserRefsPayload(userRefs, presentUserIds);
    if (missingUserPayload !== null) {
      throw missingUserRefs(missingUserPayload);
    }

    // Pre-map before opening the tx — pure transformation, no reason to hold
    // a write lock while building the row objects. Issue #163: attachment
    // rows are NOT inserted here; they are created via the per-attachment
    // `init` + presigned PUT + `complete` pipeline driven by the client
    // orchestrator (AC-253).
    const customerRows = envelope.customers.map(toCustomerInsert);
    const projectRows = envelope.projects.map(toProjectInsert);
    const assignmentRows = envelope.project_workers.map(toAssignmentInsert);

    let keysToHide: Array<{ originalKey: string; thumbKey: string | null }> = [];

    await this.db.transaction(async (tx) => {
      // VPN-first deployment (ADR-0008) rules out concurrent restores in
      // practice, so the default READ COMMITTED isolation is sufficient —
      // TRUNCATE takes ACCESS EXCLUSIVE anyway.
      const presenceResult = await tx.execute<{ present: boolean }>(
        sql`SELECT (
          EXISTS (SELECT 1 FROM customers)
          OR EXISTS (SELECT 1 FROM projects)
          OR EXISTS (SELECT 1 FROM project_workers)
          OR EXISTS (SELECT 1 FROM attachments)
        ) AS present`,
      );
      const hasExisting = presenceResult.rows[0]?.present === true;

      if (hasExisting && !opts.override) {
        throw targetNotEmpty();
      }

      // AC-160: destructive path (override into a non-empty target) demands
      // a typed confirmation phrase in the request body. The shared
      // `restorePhraseMatches` predicate keeps this check identical to the
      // client-side UX gate. Dry-run and empty-target paths never reach here.
      if (opts.override && hasExisting) {
        const typed = opts.confirmationPhrase;
        if (typeof typed !== 'string' || !restorePhraseMatches(typed)) {
          throw restoreConfirmationMismatch();
        }
        if (this.storage === null || log === undefined) {
          // The override path mutates storage state too — refuse it on
          // a service constructed without those collaborators rather
          // than silently leak the prior bytes. Empty-target callers
          // (e.g. the seed) never reach this branch.
          throw new Error('ImportService.import: override path requires storage + logger');
        }
      }

      if (opts.override) {
        // AC-254: the wipe is unconditional under override; the
        // `attachments` table is truncated atomically with the
        // customer / project / project-worker wipe so the re-upload
        // pipeline (driven by the orchestrator) lands on an empty
        // table.
        //
        // The storage objects backing the wiped rows are NOT cleaned
        // up by either reaper: the pending-orphan reaper only sweeps
        // `status='pending'` rows past TTL, and the bucket lifecycle
        // rule reaps noncurrent versions only — a TRUNCATE without a
        // hide call leaves the prior bytes as the *current* version
        // of an unreferenced key, which lifecycle never reaches
        // (issue #163 follow-up). Capture the keys before the wipe so
        // the post-commit hide demotes them to noncurrent and the
        // existing lifecycle policy reaps them on its own clock.
        // Mirrors the project-purge cascade pattern (AC-218).
        keysToHide = await listAllKeys(tx);
        await tx.execute(
          sql`TRUNCATE TABLE attachments, project_workers, projects, customers RESTART IDENTITY CASCADE`,
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

    // Post-commit project-list invalidation (AC-276). The override path
    // replaces the entire project corpus atomically; one coarse signal
    // is sufficient for every consumer to refetch (architecture.md
    // §11.13). The dry-run path returned early above and never reaches
    // here, so no `opts.dryRun` branch is needed.
    if (opts.override) {
      emitProjectChanged();
    }

    // Post-commit storage cleanup. A failure here does not abort the
    // import — the rows are already gone; orphaned keys are logged
    // and operators can sweep them later (see #169). Doing this
    // outside the tx avoids coupling a non-transactional side effect
    // to the SQL commit: a rollback after a successful hide cannot be
    // undone.
    if (keysToHide.length > 0 && this.storage !== null && log !== undefined) {
      await bestEffortHideStorageKeys(this.storage, keysToHide, log);
    }

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
