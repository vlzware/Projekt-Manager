/**
 * Project service — business logic orchestration for projects.
 *
 * Sits between routes (HTTP concerns) and repositories (data access).
 * All domain validation and error mapping lives here.
 */

import type { Database } from '../db/connection.js';
import {
  listProjects as listProjectsRepo,
  getProject as getProjectRepo,
  insertProject as insertProjectRepo,
  transitionForward as transitionForwardRepo,
  transitionBackward as transitionBackwardRepo,
  updateDates as updateDatesRepo,
  ProjectNotFoundError,
  TransitionError,
  DateValidationError,
} from '../repositories/project.js';
import { WORKFLOW_ORDER, STATE_KEYS } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, validationError } from '../errors.js';
import { emit } from './events.js';
import type { ServiceLogger } from './Logger.js';

/**
 * Translate a database-layer error (typically a `pg` error) into a
 * user-facing German message that does NOT leak constraint names, table
 * names, column names, SQLSTATE codes, or English SQL fragments. The
 * raw error is expected to be logged by the caller. See consolidation
 * review C-5.
 *
 * Drizzle wraps `pg` errors in its own error class and exposes the
 * original via `err.cause` (db-constraints.test.ts explicitly documents
 * this), while a direct `pg.Pool.query` throws with `.code` at the top
 * level. This walker accepts both shapes — a depth cap keeps the walk
 * bounded in the face of pathological cause chains.
 */
function extractSqlState(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (!(current instanceof Error)) break;
    const withCode = current as Error & { code?: string };
    // PostgreSQL SQLSTATE is a 5-character string — node's system
    // errors (ECONNREFUSED, EACCES, ...) have alphanumeric codes and
    // would not match this shape.
    if (typeof withCode.code === 'string' && /^[0-9A-Z]{5}$/.test(withCode.code)) {
      return withCode.code;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

function translatePgError(err: unknown): string {
  const code = extractSqlState(err);
  switch (code) {
    // 23505 unique_violation — the only unique index on `projects` is on
    // `number`, so this maps to the duplicate-number case. If we add more
    // unique indexes later, this branch will need constraint-name
    // discrimination before it can safely name the field.
    case '23505':
      return STRINGS.projects.duplicateNumber;
    // 23503 foreign_key_violation — likely an assignedWorkerIds entry
    // referencing a user UUID that does not exist, or created_by/updated_by
    // pointing at a missing user.
    case '23503':
      return STRINGS.projects.foreignKeyViolation;
    // 23514 check_violation — projects_end_requires_start is the only
    // CHECK constraint on the table; validation normally catches this
    // before insert, but the DB-level rejection is defense in depth.
    case '23514':
      return STRINGS.projects.dateConstraintViolation;
    default:
      return STRINGS.projects.unknownImportError;
  }
}

export interface BulkImportItem {
  number?: unknown;
  title?: unknown;
  status?: unknown;
  customer?: unknown;
  address?: unknown;
  plannedStart?: unknown;
  plannedEnd?: unknown;
  assignedWorkerIds?: unknown;
  estimatedValue?: unknown;
  notes?: unknown;
}

export interface BulkImportError {
  index: number;
  message: string;
}

export interface BulkImportResult {
  imported: number;
  errors: BulkImportError[];
}

const VALID_STATES: ReadonlySet<string> = new Set(WORKFLOW_ORDER);

export class ProjectService {
  constructor(private db: Database) {}

  async listProjects(opts: { offset?: number; limit?: number }) {
    return listProjectsRepo(this.db, opts);
  }

  async getProject(id: string) {
    const project = await getProjectRepo(this.db, id);
    if (!project) throw notFound(STRINGS.entities.project);
    return project;
  }

  async transitionForward(projectId: string, userId: string, log: ServiceLogger) {
    let result;
    try {
      result = await transitionForwardRepo(this.db, projectId, userId);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof TransitionError) throw validationError(err.message);
      throw err;
    }

    await emit(
      'project.transitioned',
      {
        projectId,
        fromStatus: result.before,
        toStatus: result.project.status,
        direction: 'forward',
        actorUserId: userId,
        occurredAt: new Date(),
      },
      log,
    );

    return result.project;
  }

  async transitionBackward(projectId: string, userId: string, log: ServiceLogger) {
    let result;
    try {
      result = await transitionBackwardRepo(this.db, projectId, userId);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof TransitionError) throw validationError(err.message);
      throw err;
    }

    await emit(
      'project.transitioned',
      {
        projectId,
        fromStatus: result.before,
        toStatus: result.project.status,
        direction: 'backward',
        actorUserId: userId,
        occurredAt: new Date(),
      },
      log,
    );

    return result.project;
  }

  async updateDates(
    projectId: string,
    userId: string,
    dates: { plannedStart?: string | null; plannedEnd?: string | null },
    log: ServiceLogger,
  ) {
    let updated;
    try {
      updated = await updateDatesRepo(this.db, projectId, userId, dates);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof DateValidationError) throw validationError(err.message);
      throw err;
    }

    await emit(
      'project.dates_changed',
      {
        projectId,
        actorUserId: userId,
        occurredAt: new Date(),
        plannedStart: dates.plannedStart,
        plannedEnd: dates.plannedEnd,
      },
      log,
    );

    return updated;
  }

  /**
   * Bulk-import projects. Each item is validated independently.
   * Successfully validated items are inserted; failures are collected as errors.
   *
   * Database-layer errors are translated via translatePgError() so the
   * client-facing `errors[].message` never contains constraint names,
   * table names, SQLSTATE codes, or English SQL fragments. The raw error
   * is logged server-side with the row index for debugging.
   * See consolidation review C-5.
   */
  async bulkImport(
    items: BulkImportItem[],
    userId: string,
    log: ServiceLogger,
  ): Promise<BulkImportResult> {
    const errors: BulkImportError[] = [];
    let imported = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const validationMsg = this.validateImportItem(item);
      if (validationMsg) {
        errors.push({ index: i, message: validationMsg });
        continue;
      }

      // At this point all required fields are validated
      const status = (item.status as string | undefined) ?? STATE_KEYS[0];

      try {
        await insertProjectRepo(this.db, {
          number: item.number as string,
          title: item.title as string,
          status: status as WorkflowState,
          customer: item.customer as { name: string; phone?: string; email?: string },
          address: item.address as { street: string; zip: string; city: string } | null | undefined,
          plannedStart: item.plannedStart ? new Date(item.plannedStart as string) : null,
          plannedEnd: item.plannedEnd ? new Date(item.plannedEnd as string) : null,
          assignedWorkerIds: item.assignedWorkerIds as string[] | null | undefined,
          estimatedValue: item.estimatedValue != null ? String(item.estimatedValue) : null,
          notes: item.notes as string | null | undefined,
          createdBy: userId,
          updatedBy: userId,
        });
        imported++;
      } catch (err) {
        log.error({ err, index: i }, 'Bulk import row failed');
        errors.push({ index: i, message: translatePgError(err) });
      }
    }

    return { imported, errors };
  }

  /**
   * Validate a single bulk-import item. Returns an error message or null if valid.
   */
  private validateImportItem(item: BulkImportItem): string | null {
    if (typeof item.number !== 'string' || item.number.trim() === '') {
      return STRINGS.validation.requiredString('number');
    }
    if (typeof item.title !== 'string' || item.title.trim() === '') {
      return STRINGS.validation.requiredString('title');
    }

    // Customer validation
    if (
      item.customer == null ||
      typeof item.customer !== 'object' ||
      Array.isArray(item.customer)
    ) {
      return STRINGS.validation.requiredObject('customer');
    }
    const customer = item.customer as Record<string, unknown>;
    if (typeof customer.name !== 'string' || customer.name.trim() === '') {
      return STRINGS.validation.requiredString('customer.name');
    }
    if (
      customer.phone !== undefined &&
      customer.phone !== null &&
      typeof customer.phone !== 'string'
    ) {
      return STRINGS.validation.mustBeString('customer.phone');
    }
    if (
      customer.email !== undefined &&
      customer.email !== null &&
      typeof customer.email !== 'string'
    ) {
      return STRINGS.validation.mustBeString('customer.email');
    }

    // Address validation (optional, but must be well-formed if present)
    if (item.address !== undefined && item.address !== null) {
      if (typeof item.address !== 'object' || Array.isArray(item.address)) {
        return STRINGS.validation.mustBeObject('address');
      }
      const addr = item.address as Record<string, unknown>;
      if (typeof addr.street !== 'string' || addr.street.trim() === '') {
        return STRINGS.validation.requiredString('address.street');
      }
      if (typeof addr.zip !== 'string' || addr.zip.trim() === '') {
        return STRINGS.validation.requiredString('address.zip');
      }
      if (typeof addr.city !== 'string' || addr.city.trim() === '') {
        return STRINGS.validation.requiredString('address.city');
      }
    }

    // Status validation
    if (item.status !== undefined && item.status !== null) {
      if (typeof item.status !== 'string' || !VALID_STATES.has(item.status)) {
        return STRINGS.projects.invalidStatus(String(item.status));
      }
    }

    // Date validation
    if (item.plannedStart !== undefined && item.plannedStart !== null) {
      if (typeof item.plannedStart !== 'string' || isNaN(Date.parse(item.plannedStart))) {
        return STRINGS.projects.invalidPlannedStart;
      }
    }
    if (item.plannedEnd !== undefined && item.plannedEnd !== null) {
      if (typeof item.plannedEnd !== 'string' || isNaN(Date.parse(item.plannedEnd))) {
        return STRINGS.projects.invalidPlannedEnd;
      }
    }
    // #54: same invariant as `updateDates` (project-dates.ts) —
    // plannedEnd cannot exist without plannedStart. The DB now enforces
    // this too via the projects_end_requires_start CHECK constraint, but
    // surface a structured German message at validation time so the
    // bulk-import error report is actionable instead of a raw PG error.
    if (
      item.plannedEnd !== undefined &&
      item.plannedEnd !== null &&
      (item.plannedStart === undefined || item.plannedStart === null)
    ) {
      return STRINGS.projects.endWithoutStart;
    }
    // Ordering invariant — matches the updateDates route path
    // (project-dates.ts: DateValidationError). The DB CHECK constraint
    // does NOT enforce ordering, only "end requires start", so the
    // bulk-import path has to catch it in application code or else
    // rows with end < start slip through silently.
    if (typeof item.plannedStart === 'string' && typeof item.plannedEnd === 'string') {
      const start = new Date(item.plannedStart);
      const end = new Date(item.plannedEnd);
      if (end.getTime() < start.getTime()) {
        return STRINGS.projects.endBeforeStart;
      }
    }

    // Assigned worker IDs validation
    if (item.assignedWorkerIds !== undefined && item.assignedWorkerIds !== null) {
      if (
        !Array.isArray(item.assignedWorkerIds) ||
        !item.assignedWorkerIds.every(
          (id: unknown) =>
            typeof id === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
        )
      ) {
        return STRINGS.validation.mustBeUuidArray('assignedWorkerIds');
      }
    }

    // Estimated value validation (optional, but must be numeric if present)
    if (item.estimatedValue !== undefined && item.estimatedValue !== null) {
      if (typeof item.estimatedValue !== 'string' && typeof item.estimatedValue !== 'number') {
        return STRINGS.validation.mustBeNumeric('estimatedValue');
      }
      if (isNaN(Number(item.estimatedValue))) {
        return STRINGS.projects.invalidEstimatedValue;
      }
    }

    // Notes validation (optional, but must be a string if present)
    if (item.notes !== undefined && item.notes !== null) {
      if (typeof item.notes !== 'string') {
        return STRINGS.validation.mustBeString('notes');
      }
    }

    return null;
  }
}
