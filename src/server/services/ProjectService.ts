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
import { notFound, validationError } from '../errors.js';

export interface BulkImportItem {
  number?: unknown;
  title?: unknown;
  status?: unknown;
  customer?: unknown;
  address?: unknown;
  plannedStart?: unknown;
  plannedEnd?: unknown;
  assignedWorkers?: unknown;
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
    if (!project) throw notFound('Projekt');
    return project;
  }

  async transitionForward(projectId: string, userId: string) {
    try {
      return await transitionForwardRepo(this.db, projectId, userId);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound('Projekt');
      if (err instanceof TransitionError) throw validationError(err.message);
      throw err;
    }
  }

  async transitionBackward(projectId: string, userId: string) {
    try {
      return await transitionBackwardRepo(this.db, projectId, userId);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound('Projekt');
      if (err instanceof TransitionError) throw validationError(err.message);
      throw err;
    }
  }

  async updateDates(
    projectId: string,
    userId: string,
    dates: { plannedStart?: string; plannedEnd?: string },
  ) {
    try {
      return await updateDatesRepo(this.db, projectId, userId, dates);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound('Projekt');
      if (err instanceof DateValidationError) throw validationError(err.message);
      throw err;
    }
  }

  /**
   * Bulk-import projects. Each item is validated independently.
   * Successfully validated items are inserted; failures are collected as errors.
   */
  async bulkImport(items: BulkImportItem[], userId: string): Promise<BulkImportResult> {
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
          assignedWorkers: item.assignedWorkers as string[] | null | undefined,
          estimatedValue: item.estimatedValue != null ? String(item.estimatedValue) : null,
          notes: item.notes as string | null | undefined,
          createdBy: userId,
          updatedBy: userId,
        });
        imported++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unbekannter Fehler beim Import.';
        errors.push({ index: i, message: msg });
      }
    }

    return { imported, errors };
  }

  /**
   * Validate a single bulk-import item. Returns an error message or null if valid.
   */
  private validateImportItem(item: BulkImportItem): string | null {
    if (typeof item.number !== 'string' || item.number.trim() === '') {
      return 'number ist erforderlich und muss ein nicht-leerer String sein.';
    }
    if (typeof item.title !== 'string' || item.title.trim() === '') {
      return 'title ist erforderlich und muss ein nicht-leerer String sein.';
    }
    if (item.customer == null || typeof item.customer !== 'object' || Array.isArray(item.customer)) {
      return 'customer ist erforderlich und muss ein Objekt sein.';
    }
    const customer = item.customer as Record<string, unknown>;
    if (typeof customer.name !== 'string' || customer.name.trim() === '') {
      return 'customer.name ist erforderlich und muss ein nicht-leerer String sein.';
    }
    if (item.status !== undefined && item.status !== null) {
      if (typeof item.status !== 'string' || !VALID_STATES.has(item.status)) {
        return `status '${String(item.status)}' ist kein gültiger Workflow-Status.`;
      }
    }
    return null;
  }
}
