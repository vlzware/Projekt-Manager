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
  updateProject as updateProjectRepo,
  softDeleteProject as softDeleteProjectRepo,
  transitionForward as transitionForwardRepo,
  transitionBackward as transitionBackwardRepo,
  updateDates as updateDatesRepo,
  ProjectNotFoundError,
  TransitionError,
  ConcurrentModificationError,
  DateValidationError,
} from '../repositories/project.js';
import type { ListProjectsOpts } from '../repositories/project-read.js';
import { WORKFLOW_ORDER, STATE_KEYS } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, validationError, conflict, extractSqlState } from '../errors.js';
import { emit } from './events.js';
import type { ServiceLogger } from './Logger.js';

function translatePgError(err: unknown): string {
  const code = extractSqlState(err);
  switch (code) {
    case '23505':
      return STRINGS.projects.duplicateNumber;
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
      if (sqlState === '23505') throw conflict(STRINGS.projects.duplicateNumber);
      if (sqlState === '23503') throw validationError(STRINGS.projects.foreignKeyViolation);
      throw err;
    }
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
        errors.push({ index: i, message: translatePgError(err) });
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
