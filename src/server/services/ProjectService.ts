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
  getProjectRowById,
  insertProject as insertProjectRepo,
  updateProject as updateProjectRepo,
  softDeleteProject as softDeleteProjectRepo,
  transitionForward as transitionForwardRepo,
  transitionBackward as transitionBackwardRepo,
  updateDates as updateDatesRepo,
  fetchWorkersForProject,
  toProject,
  ProjectNotFoundError,
  TransitionError,
  ConcurrentModificationError,
  DateValidationError,
} from '../repositories/project.js';
import type { ListProjectsOpts, ProjectRow } from '../repositories/project-read.js';
import { customers } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { WORKFLOW_ORDER, STATE_KEYS } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { DB_CONSTRAINTS } from '../db/constraints.js';
import {
  notFound,
  validationError,
  conflict,
  idempotencyConflict,
  extractSqlState,
  extractPgConstraint,
} from '../errors.js';
import { projectMatches } from './idempotency.js';
import { emit } from './events.js';
import type { ServiceLogger } from './Logger.js';

function translatePgError(err: unknown, ctx: { number?: string } = {}): string {
  const code = extractSqlState(err);
  switch (code) {
    case '23505':
      return STRINGS.projects.duplicateNumber(ctx.number ?? '');
    case '23503':
      return STRINGS.projects.foreignKeyViolation;
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
  customerId?: unknown;
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ProjectService {
  constructor(private db: Database) {}

  async listProjects(opts: ListProjectsOpts) {
    return listProjectsRepo(this.db, opts);
  }

  async getProject(id: string) {
    const project = await getProjectRepo(this.db, id);
    if (!project) throw notFound(STRINGS.entities.project);
    return project;
  }

  async createProject(
    data: {
      id?: string;
      number: string;
      title: string;
      customerId: string;
      status?: string;
      plannedStart?: string | null;
      plannedEnd?: string | null;
      assignedWorkerIds?: string[];
      estimatedValue?: number | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
  ) {
    const status = (data.status ?? STATE_KEYS[0]) as WorkflowState;
    if (!VALID_STATES.has(status)) {
      throw validationError(STRINGS.projects.invalidStatus(status));
    }

    if (data.id !== undefined) {
      return this.createProjectWithClientId({ ...data, id: data.id, status }, userId, log);
    }

    try {
      const project = await insertProjectRepo(this.db, {
        number: data.number,
        title: data.title,
        status,
        customerId: data.customerId,
        plannedStart: data.plannedStart ? new Date(data.plannedStart) : null,
        plannedEnd: data.plannedEnd ? new Date(data.plannedEnd) : null,
        assignedWorkerIds: data.assignedWorkerIds ?? null,
        estimatedValue: data.estimatedValue != null ? String(data.estimatedValue) : null,
        notes: data.notes ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
      log.info({ projectId: project.id }, 'project_created');
      return project;
    } catch (err) {
      const sqlState = extractSqlState(err);
      if (sqlState === '23505') throw conflict(STRINGS.projects.duplicateNumber(data.number));
      if (sqlState === '23503') throw validationError(STRINGS.projects.foreignKeyViolation);
      throw err;
    }
  }

  private async createProjectWithClientId(
    data: {
      id: string;
      number: string;
      title: string;
      customerId: string;
      status: WorkflowState;
      plannedStart?: string | null;
      plannedEnd?: string | null;
      assignedWorkerIds?: string[];
      estimatedValue?: number | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
  ) {
    const matchInput = {
      number: data.number,
      title: data.title,
      customerId: data.customerId,
      status: data.status,
      plannedStart: data.plannedStart ?? null,
      plannedEnd: data.plannedEnd ?? null,
      assignedWorkerIds: data.assignedWorkerIds ?? [],
      estimatedValue: data.estimatedValue ?? null,
      notes: data.notes ?? null,
    };

    // Pre-SELECT is best-effort — under READ COMMITTED a concurrent insert
    // can still slip between this lookup and the INSERT below. The 23505
    // catch block is the actual race handler.
    const existing = await getProjectRowById(this.db, data.id);
    if (existing) {
      const workers = await fetchWorkersForProject(this.db, data.id);
      if (!this.storedMatchesIncoming(existing, workers, matchInput)) {
        throw idempotencyConflict();
      }
      log.info({ projectId: data.id }, 'project_create_replayed');
      return this.hydrateReplayedProject(existing, workers);
    }

    try {
      const inserted = await insertProjectRepo(this.db, {
        id: data.id,
        number: data.number,
        title: data.title,
        status: data.status,
        customerId: data.customerId,
        plannedStart: data.plannedStart ? new Date(data.plannedStart) : null,
        plannedEnd: data.plannedEnd ? new Date(data.plannedEnd) : null,
        assignedWorkerIds: data.assignedWorkerIds ?? null,
        estimatedValue: data.estimatedValue != null ? String(data.estimatedValue) : null,
        notes: data.notes ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
      log.info({ projectId: data.id }, 'project_created');
      return inserted;
    } catch (err) {
      const sqlState = extractSqlState(err);
      if (sqlState !== '23505') {
        if (sqlState === '23503') throw validationError(STRINGS.projects.foreignKeyViolation);
        throw err;
      }

      // 23505 with client-supplied id has two plausible constraints:
      //   projects_pkey         — racing idempotent replay on the same id
      //   projects_number_unique — real number collision
      // Use the pg-attached `constraint` to disambiguate; fall back to a
      // post-hoc id lookup when the driver omits it (node-postgres sets it
      // reliably for unique_violation, but defense-in-depth).
      const constraint = extractPgConstraint(err);
      if (constraint === DB_CONSTRAINTS.projects.numberUnique) {
        throw conflict(STRINGS.projects.duplicateNumber(data.number));
      }
      if (constraint === DB_CONSTRAINTS.projects.pkey || constraint === null) {
        const row = await getProjectRowById(this.db, data.id);
        if (row) {
          const workers = await fetchWorkersForProject(this.db, data.id);
          if (!this.storedMatchesIncoming(row, workers, matchInput)) {
            throw idempotencyConflict();
          }
          log.info({ projectId: data.id }, 'project_create_replayed');
          return this.hydrateReplayedProject(row, workers);
        }
        // No matching id → it must have been the number constraint after all.
        throw conflict(STRINGS.projects.duplicateNumber(data.number));
      }
      throw err;
    }
  }

  private storedMatchesIncoming(
    row: ProjectRow,
    workers: { userId: string; displayName: string }[],
    incoming: {
      number: string;
      title: string;
      customerId: string;
      status: WorkflowState;
      plannedStart: string | null;
      plannedEnd: string | null;
      assignedWorkerIds: string[];
      estimatedValue: number | null;
      notes: string | null;
    },
  ): boolean {
    return projectMatches(incoming, {
      number: row.number,
      title: row.title,
      customerId: row.customerId,
      status: row.status,
      plannedStart: row.plannedStart,
      plannedEnd: row.plannedEnd,
      assignedWorkerIds: workers.map((w) => w.userId),
      estimatedValue: row.estimatedValue,
      notes: row.notes,
    });
  }

  private async hydrateReplayedProject(
    row: ProjectRow,
    workers: { userId: string; displayName: string }[],
  ) {
    const customerRows = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, row.customerId))
      .limit(1);
    return toProject(row, customerRows[0] ?? null, workers);
  }

  async updateProject(
    id: string,
    data: {
      title?: string;
      customerId?: string;
      assignedWorkerIds?: string[];
      estimatedValue?: number | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
  ) {
    try {
      const project = await updateProjectRepo(this.db, id, userId, data);
      log.info({ projectId: id }, 'project_updated');
      return project;
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      throw err;
    }
  }

  async deleteProject(id: string, userId: string, log: ServiceLogger) {
    try {
      await softDeleteProjectRepo(this.db, id, userId);
      log.info({ projectId: id }, 'project_deleted');
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      throw err;
    }
  }

  async transitionForward(projectId: string, userId: string, log: ServiceLogger) {
    let result;
    try {
      result = await transitionForwardRepo(this.db, projectId, userId);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof TransitionError) throw validationError(err.message);
      if (err instanceof ConcurrentModificationError) throw conflict(err.message);
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
      if (err instanceof ConcurrentModificationError) throw conflict(err.message);
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

      const status = (item.status as string | undefined) ?? STATE_KEYS[0];
      const customerId = item.customerId as string;

      try {
        await insertProjectRepo(this.db, {
          number: item.number as string,
          title: item.title as string,
          status: status as WorkflowState,
          customerId,
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
        errors.push({
          index: i,
          message: translatePgError(err, { number: item.number as string }),
        });
      }
    }

    return { imported, errors };
  }

  /**
   * Validate a single bulk-import item. Returns an error message or null if valid.
   *
   * Must enforce the same invariants as the single-record JSON Schema in
   * routes/projects.ts — UUID format, ISO date format, max lengths, etc.
   */
  private validateImportItem(item: BulkImportItem): string | null {
    if (typeof item.number !== 'string' || item.number.trim() === '') {
      return STRINGS.validation.requiredString('number');
    }
    if (item.number.length > 20) {
      return STRINGS.validation.maxLength('number', 20);
    }
    if (typeof item.title !== 'string' || item.title.trim() === '') {
      return STRINGS.validation.requiredString('title');
    }
    if (item.title.length > 500) {
      return STRINGS.validation.maxLength('title', 500);
    }

    // Customer validation: customerId is required and must be a UUID
    if (typeof item.customerId !== 'string' || !UUID_RE.test(item.customerId)) {
      return STRINGS.validation.mustBeUuid('customerId');
    }

    // Status validation
    if (item.status !== undefined && item.status !== null) {
      if (typeof item.status !== 'string' || !VALID_STATES.has(item.status)) {
        return STRINGS.projects.invalidStatus(String(item.status));
      }
    }

    // Date validation — require strict ISO 8601 date format (YYYY-MM-DD)
    if (item.plannedStart !== undefined && item.plannedStart !== null) {
      if (typeof item.plannedStart !== 'string' || !ISO_DATE_RE.test(item.plannedStart)) {
        return STRINGS.projects.invalidPlannedStart;
      }
    }
    if (item.plannedEnd !== undefined && item.plannedEnd !== null) {
      if (typeof item.plannedEnd !== 'string' || !ISO_DATE_RE.test(item.plannedEnd)) {
        return STRINGS.projects.invalidPlannedEnd;
      }
    }
    if (
      item.plannedEnd !== undefined &&
      item.plannedEnd !== null &&
      (item.plannedStart === undefined || item.plannedStart === null)
    ) {
      return STRINGS.projects.endWithoutStart;
    }
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
        !item.assignedWorkerIds.every((id: unknown) => typeof id === 'string' && UUID_RE.test(id))
      ) {
        return STRINGS.validation.mustBeUuidArray('assignedWorkerIds');
      }
    }

    // Estimated value
    if (item.estimatedValue !== undefined && item.estimatedValue !== null) {
      if (typeof item.estimatedValue !== 'string' && typeof item.estimatedValue !== 'number') {
        return STRINGS.validation.mustBeNumeric('estimatedValue');
      }
      if (isNaN(Number(item.estimatedValue))) {
        return STRINGS.projects.invalidEstimatedValue;
      }
    }

    // Notes
    if (item.notes !== undefined && item.notes !== null) {
      if (typeof item.notes !== 'string') {
        return STRINGS.validation.mustBeString('notes');
      }
    }

    return null;
  }
}
