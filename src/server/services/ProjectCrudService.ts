/**
 * Project CRUD service — business logic for list/get/create/update/
 * archive/purge + worker-assignment side effects.
 *
 * Every domain-entity mutation routes through `mutate()` (ADR-0021).
 * Service methods capture `payload.before`/`after` for the audit row
 * inside the same transaction as the state change.
 *
 * Transitions live in ProjectTransitionService; planned-date updates
 * live in ProjectDatesService.
 */

import type { Database } from '../db/connection.js';
import {
  listProjects as listProjectsRepo,
  getProject as getProjectRepo,
  getProjectRowById,
  getProjectForMutation,
  insertProject as insertProjectRepo,
  updateProjectFields,
  diffProjectWorkers,
  addProjectWorker,
  removeProjectWorker,
  softDeleteProject as softDeleteProjectRepo,
  hardDeleteProject as hardDeleteProjectRepo,
  fetchWorkersForProject,
  getUserDisplayName,
  toProject,
  ProjectNotFoundError,
  ProjectNotArchivedError,
} from '../repositories/project.js';
import type { ListProjectsOpts, ProjectRow } from '../repositories/project-read.js';
import { customers, projects } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { WORKFLOW_ORDER, STATE_KEYS } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { DB_CONSTRAINTS } from '../db/constraints.js';
import { notFound, notPermitted, validationError, conflict, extractSqlState } from '../errors.js';
import { projectMatches, createIdempotent } from './idempotency.js';
import type { ServiceLogger } from './Logger.js';
import type { AuthUser } from '../middleware/auth.js';
import { isOutOfScope } from '../repositories/scope.js';
import { mutate, mutateInTx, dispatchAuditRows } from './mutate.js';
import type { AuditLogRow } from './audit-publisher.js';

const VALID_STATES: ReadonlySet<string> = new Set(WORKFLOW_ORDER);

/**
 * Subset of project fields considered for the `update` audit payload.
 * Excludes server-managed timestamps and the immutable identifier — the
 * spec pins changed fields only.
 */
function projectUpdatableDiff(row: {
  title: string;
  customerId: string;
  estimatedValue: string | null;
  notes: string | null;
}): Record<string, unknown> {
  return {
    title: row.title,
    customerId: row.customerId,
    estimatedValue: row.estimatedValue ?? null,
    notes: row.notes ?? null,
  };
}

export class ProjectCrudService {
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
    correlationId?: string | null,
  ) {
    const status = (data.status ?? STATE_KEYS[0]) as WorkflowState;
    if (!VALID_STATES.has(status)) {
      throw validationError(STRINGS.projects.invalidStatus(status));
    }

    if (data.id !== undefined) {
      return this.createProjectWithClientId(
        { ...data, id: data.id, status },
        userId,
        log,
        correlationId,
      );
    }

    try {
      const project = await this.runCreateWithAudit(
        {
          number: data.number,
          title: data.title,
          status,
          customerId: data.customerId,
          plannedStart: data.plannedStart ? new Date(data.plannedStart) : null,
          plannedEnd: data.plannedEnd ? new Date(data.plannedEnd) : null,
          assignedWorkerIds: data.assignedWorkerIds ?? [],
          estimatedValue: data.estimatedValue != null ? String(data.estimatedValue) : null,
          notes: data.notes ?? null,
        },
        userId,
        correlationId,
      );
      log.info({ projectId: project.id }, 'project_created');
      return project;
    } catch (err) {
      const sqlState = extractSqlState(err);
      if (sqlState === '23505') throw conflict(STRINGS.projects.duplicateNumber(data.number));
      if (sqlState === '23503') throw validationError(STRINGS.projects.foreignKeyViolation);
      throw err;
    }
  }

  /**
   * Creates the project + optional worker assignments inside a single
   * transaction, emitting one `create` audit row for the project and
   * one `create` row per assigned worker. All commits happen atomically;
   * audit dispatch runs after commit (AC-177, AC-183).
   */
  private async runCreateWithAudit(
    data: {
      id?: string;
      number: string;
      title: string;
      status: WorkflowState;
      customerId: string;
      plannedStart: Date | null;
      plannedEnd: Date | null;
      assignedWorkerIds: string[];
      estimatedValue: string | null;
      notes: string | null;
    },
    userId: string,
    correlationId?: string | null,
  ): Promise<ReturnType<typeof toProject>> {
    const ctx = {
      actorKind: 'user' as const,
      actorId: userId,
      correlationId: correlationId ?? null,
    };
    const collected: AuditLogRow[] = [];

    const project = await this.db.transaction(async (tx) => {
      const { value: inserted, auditRow: createRow } = await mutateInTx(tx, ctx, {
        entityType: 'project',
        action: 'create',
        run: async (innerTx) => {
          const row = await insertProjectRepo(innerTx, {
            id: data.id,
            number: data.number,
            title: data.title,
            status: data.status,
            customerId: data.customerId,
            plannedStart: data.plannedStart,
            plannedEnd: data.plannedEnd,
            estimatedValue: data.estimatedValue,
            notes: data.notes,
            createdBy: userId,
            updatedBy: userId,
          });
          return {
            entityId: row.id,
            value: row,
            before: {},
            after: {
              number: row.number,
              title: row.title,
              status: row.status,
              customerId: row.customerId,
              plannedStart: row.plannedStart,
              plannedEnd: row.plannedEnd,
              estimatedValue: row.estimatedValue,
              notes: row.notes,
            },
          };
        },
      });
      collected.push(createRow);

      // Each worker assignment is its own audit event — makes worker
      // reachability queries (AC-180) cheap: a single row references
      // one project and one user. The payload includes the worker's
      // displayName so the activity feed can render "Mitarbeiter
      // zugewiesen: Jan Nowak" (ui/workflow-views.md §8.4.1) without a
      // second round-trip.
      for (const workerId of data.assignedWorkerIds) {
        const { auditRow } = await mutateInTx(tx, ctx, {
          entityType: 'project_worker',
          action: 'create',
          run: async (innerTx) => {
            await addProjectWorker(innerTx, inserted.id, workerId);
            const displayName = await getUserDisplayName(innerTx, workerId);
            return {
              entityId: inserted.id,
              value: null,
              before: {},
              after: { projectId: inserted.id, userId: workerId, displayName },
            };
          },
        });
        collected.push(auditRow);
      }

      const workers = await fetchWorkersForProject(tx, inserted.id);
      const customerRows = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, inserted.customerId))
        .limit(1);
      return toProject(inserted, customerRows[0] ?? null, workers);
    });

    await dispatchAuditRows(collected);
    return project;
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
    correlationId?: string | null,
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
          const inserted = await this.runCreateWithAudit(
            {
              id: data.id,
              number: data.number,
              title: data.title,
              status: data.status,
              customerId: data.customerId,
              plannedStart: data.plannedStart ? new Date(data.plannedStart) : null,
              plannedEnd: data.plannedEnd ? new Date(data.plannedEnd) : null,
              assignedWorkerIds: data.assignedWorkerIds ?? [],
              estimatedValue: data.estimatedValue != null ? String(data.estimatedValue) : null,
              notes: data.notes ?? null,
            },
            userId,
            correlationId,
          );
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

  /**
   * PATCH /api/projects/:id — field update and/or worker reassignment.
   *
   * Field updates (title/customerId/estimatedValue/notes) produce a
   * single `update` audit row carrying the diff.
   *
   * Worker reassignment produces one `project_worker` row per actual
   * add and one per actual remove — ids present in both sides are
   * idempotent no-ops with no audit event. If the caller supplies
   * only `assignedWorkerIds` without touching other fields, NO
   * `update` audit row is emitted for the project itself; only the
   * `project_worker` audit rows land. This matches the grain pinned
   * in AT-89 (count(project_worker audit rows) == count of changes).
   */
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
    correlationId?: string | null,
  ) {
    const ctx = {
      actorKind: 'user' as const,
      actorId: userId,
      correlationId: correlationId ?? null,
    };
    const collected: AuditLogRow[] = [];
    const hasFieldUpdate =
      data.title !== undefined ||
      data.customerId !== undefined ||
      data.estimatedValue !== undefined ||
      data.notes !== undefined;

    try {
      const project = await this.db.transaction(async (tx) => {
        const priorRow = await getProjectForMutation(tx, id);
        if (!priorRow) throw new ProjectNotFoundError();

        let currentRow: ProjectRow = priorRow;

        if (hasFieldUpdate) {
          const fieldUpdate = await mutateInTx(tx, ctx, {
            entityType: 'project',
            action: 'update',
            run: async (innerTx) => {
              const updated = await updateProjectFields(innerTx, id, userId, {
                title: data.title,
                customerId: data.customerId,
                estimatedValue: data.estimatedValue,
                notes: data.notes,
              });
              if (!updated) throw new ProjectNotFoundError();

              const before: Record<string, unknown> = {};
              const after: Record<string, unknown> = {};
              const priorDiff = projectUpdatableDiff({
                title: priorRow.title,
                customerId: priorRow.customerId,
                estimatedValue: priorRow.estimatedValue,
                notes: priorRow.notes,
              });
              const updatedDiff = projectUpdatableDiff({
                title: updated.title,
                customerId: updated.customerId,
                estimatedValue: updated.estimatedValue,
                notes: updated.notes,
              });
              if (data.title !== undefined) {
                before.title = priorDiff.title;
                after.title = updatedDiff.title;
              }
              if (data.customerId !== undefined) {
                before.customerId = priorDiff.customerId;
                after.customerId = updatedDiff.customerId;
              }
              if (data.estimatedValue !== undefined) {
                before.estimatedValue = priorDiff.estimatedValue;
                after.estimatedValue = updatedDiff.estimatedValue;
              }
              if (data.notes !== undefined) {
                before.notes = priorDiff.notes;
                after.notes = updatedDiff.notes;
              }

              return { entityId: id, value: updated, before, after };
            },
          });
          collected.push(fieldUpdate.auditRow);
          currentRow = fieldUpdate.value;
        }

        // Worker reassignment — emit one audit row per add/remove. Each
        // row carries the worker's displayName so the activity feed can
        // render the user-facing message without a second lookup (see
        // `ui/workflow-views.md §8.4.1` and `describeAuditRow`).
        if (data.assignedWorkerIds !== undefined) {
          const { toAdd, toRemove } = await diffProjectWorkers(tx, id, data.assignedWorkerIds);
          for (const workerId of toRemove) {
            const res = await mutateInTx(tx, ctx, {
              entityType: 'project_worker',
              action: 'delete',
              run: async (innerTx) => {
                const displayName = await getUserDisplayName(innerTx, workerId);
                await removeProjectWorker(innerTx, id, workerId);
                return {
                  entityId: id,
                  value: null,
                  before: { projectId: id, userId: workerId, displayName },
                  after: {},
                };
              },
            });
            collected.push(res.auditRow);
          }
          for (const workerId of toAdd) {
            const res = await mutateInTx(tx, ctx, {
              entityType: 'project_worker',
              action: 'create',
              run: async (innerTx) => {
                await addProjectWorker(innerTx, id, workerId);
                const displayName = await getUserDisplayName(innerTx, workerId);
                return {
                  entityId: id,
                  value: null,
                  before: {},
                  after: { projectId: id, userId: workerId, displayName },
                };
              },
            });
            collected.push(res.auditRow);
          }
        }

        const workers = await fetchWorkersForProject(tx, id);
        const customerRows = await tx
          .select()
          .from(customers)
          .where(eq(customers.id, currentRow.customerId))
          .limit(1);
        return toProject(currentRow, customerRows[0] ?? null, workers);
      });

      await dispatchAuditRows(collected);

      log.info({ projectId: id }, 'project_updated');
      return project;
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      throw err;
    }
  }

  async deleteProject(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    try {
      await mutate(
        this.db,
        { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
        {
          entityType: 'project',
          // Soft-delete is the board-archive flow — ADR-0017 pins it as
          // a non-destructive operation (the row is recoverable). The
          // `archive` action keeps it distinct from hard-delete (`purge`)
          // and from the generic `delete` used on project_workers and
          // user entities. Payload is the spec-shaped `{ before: {...},
          // after: {} }` (data-model.md §5.10: "for a delete or purge,
          // `after` is empty") — the action key carries the semantic
          // distinction, not a `{ deleted: true }` flag in the payload.
          action: 'archive',
          run: async (tx) => {
            const priorRow = await getProjectForMutation(tx, id);
            if (!priorRow) throw new ProjectNotFoundError();
            await softDeleteProjectRepo(tx, id, userId);
            return {
              entityId: id,
              value: null,
              before: { number: priorRow.number, title: priorRow.title },
              after: {},
            };
          },
        },
      );
      log.info({ projectId: id }, 'project_archived');
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      throw err;
    }
  }

  async purgeProject(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    try {
      await mutate(
        this.db,
        { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
        {
          entityType: 'project',
          action: 'purge',
          run: async (tx) => {
            // Read pre-delete state for the audit payload. The repository
            // throws ProjectNotFoundError for missing rows and
            // ProjectNotArchivedError for non-archived rows; we catch both
            // outside the tx and map to HTTP codes.
            const priorRows = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
            const priorRow = priorRows[0];
            await hardDeleteProjectRepo(tx, id);
            return {
              entityId: id,
              value: null,
              before: priorRow ? { number: priorRow.number, title: priorRow.title } : {},
              after: {},
            };
          },
        },
      );
      log.info({ projectId: id, actorUserId: userId }, 'project_purged');
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof ProjectNotArchivedError) {
        throw conflict(STRINGS.projects.purgeRequiresArchive);
      }
      throw err;
    }
  }
}
