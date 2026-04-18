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
  hardDeleteProject as hardDeleteProjectRepo,
  transitionForward as transitionForwardRepo,
  transitionBackward as transitionBackwardRepo,
  updateDates as updateDatesRepo,
  fetchWorkersForProject,
  toProject,
  ProjectNotFoundError,
  ProjectNotArchivedError,
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
import { notFound, notPermitted, validationError, conflict, extractSqlState } from '../errors.js';
import { projectMatches, createIdempotent } from './idempotency.js';
import { emit } from './events.js';
import type { ServiceLogger } from './Logger.js';
import type { AuthUser } from '../middleware/auth.js';
import { isOutOfScope } from '../repositories/scope.js';

const VALID_STATES: ReadonlySet<string> = new Set(WORKFLOW_ORDER);

export class ProjectService {
  constructor(private db: Database) {}

  async listProjects(caller: AuthUser, opts: ListProjectsOpts) {
    return listProjectsRepo(this.db, caller, opts);
  }

  async getProject(caller: AuthUser, id: string) {
    const result = await getProjectRepo(this.db, caller, id);
    if (result === null) throw notFound(STRINGS.entities.project);
    // AC-147: an existing project the caller is not assigned to surfaces
    // as 403 NOT_PERMITTED, not 404. The spec accepts the existence leak
    // because project IDs are UUIDs and callers are internal users.
    if (isOutOfScope(result)) throw notPermitted();
    return result;
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

    return createIdempotent({
      preSelectRow: () => getProjectRowById(this.db, data.id),
      replayFromRow: async (row) => {
        const workers = await fetchWorkersForProject(this.db, data.id);
        if (!this.storedMatchesIncoming(row, workers, matchInput)) return null;
        log.info({ projectId: data.id }, 'project_create_replayed');
        return this.hydrateReplayedProject(row, workers);
      },
      insert: async () => {
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
          // 23503 is customerId FK violation — map before the idempotency
          // helper sees it, since 23503 is not in its 23505 branch anyway.
          if (extractSqlState(err) === '23503') {
            throw validationError(STRINGS.projects.foreignKeyViolation);
          }
          throw err;
        }
      },
      // Id race: pkey, or driver omitted the constraint name.
      isIdRaceConstraint: (c) => c === DB_CONSTRAINTS.projects.pkey || c === null,
      // Any other 23505 — or pkey/null with no matching row on re-read — is
      // a real `number` collision. (Re-read finding nothing under pkey/null
      // means the 23505 was actually on number_unique; the driver just
      // didn't attach the constraint name.)
      onNonIdRaceConstraint: () => {
        throw conflict(STRINGS.projects.duplicateNumber(data.number));
      },
    });
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

  /**
   * Hard-delete an archived project (AC-155/156/158). Archive is a
   * precondition — the repository enforces it and surfaces
   * `ProjectNotArchivedError` for non-archived rows, which we map to
   * 409 CONFLICT with the German `purgeRequiresArchive` copy.
   *
   * `project_workers` cascade via the FK; no explicit cleanup here.
   */
  async purgeProject(id: string, userId: string, log: ServiceLogger) {
    try {
      await hardDeleteProjectRepo(this.db, id);
      log.info({ projectId: id, actorUserId: userId }, 'project_purged');
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof ProjectNotArchivedError) {
        throw conflict(STRINGS.projects.purgeRequiresArchive);
      }
      throw err;
    }
  }

  async transitionForward(
    projectId: string,
    userId: string,
    expectedStatus: WorkflowState,
    log: ServiceLogger,
  ) {
    let result;
    try {
      result = await transitionForwardRepo(this.db, projectId, userId, expectedStatus);
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

  async transitionBackward(
    projectId: string,
    userId: string,
    expectedStatus: WorkflowState,
    log: ServiceLogger,
  ) {
    let result;
    try {
      result = await transitionBackwardRepo(this.db, projectId, userId, expectedStatus);
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
