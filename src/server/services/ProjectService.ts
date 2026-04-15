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

const VALID_STATES: ReadonlySet<string> = new Set(WORKFLOW_ORDER);

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
}
