/**
 * Customer service — business logic orchestration for customers.
 *
 * Every mutation routes through `mutate()` (ADR-0021). Service methods
 * capture `payload.before`/`after` for the audit row inside the same
 * transaction as the write.
 */

import type { Database } from '../db/connection.js';
import { eq, and } from 'drizzle-orm';
import {
  listCustomers as listCustomersRepo,
  getCustomer as getCustomerRepo,
  createCustomer as createCustomerRepo,
  updateCustomer as updateCustomerRepo,
  deleteCustomer as deleteCustomerRepo,
  getCustomerRow,
  toCustomerResponse,
} from '../repositories/customer.js';
import { projects } from '../db/schema.js';
import { hardDeleteProjectUnchecked } from '../repositories/project.js';
import { DB_CONSTRAINTS } from '../db/constraints.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, notPermitted, conflict } from '../errors.js';
import { customerMatches, createIdempotent } from './idempotency.js';
import type { ServiceLogger } from './Logger.js';
import type { AuthUser } from '../middleware/auth.js';
import { isOutOfScope } from '../repositories/scope.js';
import { mutate, mutateInTx, dispatchAuditRows } from './mutate.js';
import type { AuditLogRow } from './audit-publisher.js';

/**
 * Fields captured in the audit payload for customer writes. Kept as a
 * `Record<string, unknown>` subset so the service can include only the
 * fields that actually changed (update) or the new row (create).
 */
type CustomerDiff = Record<string, unknown>;

function customerDiffFields(row: {
  name: string;
  phone: string | null;
  email: string | null;
  address: { street: string; zip: string; city: string } | null;
  notes: string | null;
}): CustomerDiff {
  return {
    name: row.name,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    notes: row.notes ?? null,
  };
}

export class CustomerService {
  constructor(private db: Database) {}

  async listCustomers(
    caller: AuthUser,
    opts: { offset?: number; limit?: number; search?: string },
  ) {
    return listCustomersRepo(this.db, caller, opts);
  }

  async getCustomer(caller: AuthUser, id: string) {
    const result = await getCustomerRepo(this.db, caller, id);
    if (result === null) throw notFound(STRINGS.entities.customer);
    // AC-148: out-of-scope → 403 NOT_PERMITTED, not 404.
    if (isOutOfScope(result)) throw notPermitted();
    return result;
  }

  async createCustomer(
    data: {
      id?: string;
      name: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    if (data.id !== undefined) {
      return this.createCustomerWithClientId(data, data.id, userId, log, correlationId);
    }

    const customer = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'customer',
        action: 'create',
        run: async (tx) => {
          const inserted = await createCustomerRepo(tx, {
            ...data,
            createdBy: userId,
            updatedBy: userId,
          });
          return {
            entityId: inserted.id,
            value: inserted,
            before: {},
            after: customerDiffFields({
              name: inserted.name,
              phone: inserted.phone,
              email: inserted.email,
              address: inserted.address,
              notes: inserted.notes,
            }),
          };
        },
      },
    );
    log.info({ customerId: customer.id }, 'customer_created');
    return customer;
  }

  private async createCustomerWithClientId(
    data: {
      name: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    return createIdempotent({
      preSelectRow: () => getCustomerRow(this.db, id),
      replayFromRow: async (row) => {
        if (!customerMatches(data, row)) return null;
        log.info({ customerId: id }, 'customer_create_replayed');
        return toCustomerResponse(row);
      },
      insert: async () => {
        const inserted = await mutate(
          this.db,
          { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
          {
            entityType: 'customer',
            action: 'create',
            run: async (tx) => {
              const row = await createCustomerRepo(tx, {
                id,
                ...data,
                createdBy: userId,
                updatedBy: userId,
              });
              return {
                entityId: row.id,
                value: row,
                before: {},
                after: customerDiffFields({
                  name: row.name,
                  phone: row.phone,
                  email: row.email,
                  address: row.address,
                  notes: row.notes,
                }),
              };
            },
          },
        );
        log.info({ customerId: id }, 'customer_created');
        return inserted;
      },
      isIdRaceConstraint: (c) => c === DB_CONSTRAINTS.customers.pkey || c === null,
      // Customers have no other unique constraint — a 23505 the helper can't
      // resolve as id-race is genuinely unexpected. Rethrow untouched.
      onNonIdRaceConstraint: (err) => {
        throw err;
      },
    });
  }

  async updateCustomer(
    id: string,
    data: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    const customer = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'customer',
        action: 'update',
        run: async (tx) => {
          const priorRow = await getCustomerRow(tx, id);
          if (!priorRow) throw notFound(STRINGS.entities.customer);

          const updated = await updateCustomerRepo(tx, id, userId, data);
          if (!updated) throw notFound(STRINGS.entities.customer);

          const changed = diffCustomerChange(priorRow, data);
          return {
            entityId: id,
            value: updated,
            before: changed.before,
            after: changed.after,
          };
        },
      },
    );
    log.info({ customerId: id }, 'customer_updated');
    return customer;
  }

  async deleteCustomer(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    // Check for active (non-archived) projects referencing this customer.
    const activeProjects = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.customerId, id), eq(projects.deleted, false)))
      .limit(1);

    if (activeProjects.length > 0) {
      throw conflict(STRINGS.customers.hasProjects);
    }

    // All referencing projects (if any) are archived. Delete them and
    // the customer atomically — the archive has no value without the
    // customer. `project_workers` rows cascade via FK. Every audited
    // write goes through `mutateInTx()` so multiple audit rows share one
    // transaction; post-commit dispatch happens outside the tx.
    const collectedAudit: AuditLogRow[] = [];
    const ctx = {
      actorKind: 'user' as const,
      actorId: userId,
      correlationId: correlationId ?? null,
    };

    await this.db.transaction(async (tx) => {
      const archived = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.customerId, id), eq(projects.deleted, true)));

      for (const row of archived) {
        const { auditRow } = await mutateInTx(tx, ctx, {
          entityType: 'project',
          action: 'purge',
          run: async (innerTx) => {
            await hardDeleteProjectUnchecked(innerTx, row.id);
            return {
              entityId: row.id,
              value: null,
              before: { number: row.number, title: row.title, customerId: row.customerId },
              after: {},
            };
          },
        });
        collectedAudit.push(auditRow);
      }

      if (archived.length > 0) {
        log.info(
          { customerId: id, archivedProjectsRemoved: archived.length },
          'archived_projects_purged',
        );
      }

      const { auditRow: deleteAudit } = await mutateInTx(tx, ctx, {
        entityType: 'customer',
        action: 'delete',
        run: async (innerTx) => {
          const priorRow = await getCustomerRow(innerTx, id);
          if (!priorRow) throw notFound(STRINGS.entities.customer);

          const deleted = await deleteCustomerRepo(innerTx, id);
          if (!deleted) throw notFound(STRINGS.entities.customer);

          return {
            entityId: id,
            value: null,
            before: customerDiffFields({
              name: priorRow.name,
              phone: priorRow.phone,
              email: priorRow.email,
              address: priorRow.address,
              notes: priorRow.notes,
            }),
            after: {},
          };
        },
      });
      collectedAudit.push(deleteAudit);
    });

    // Publisher dispatch runs after the transaction commits — AC-183.
    await dispatchAuditRows(collectedAudit);

    log.info({ customerId: id }, 'customer_deleted');
  }
}

/**
 * Compute the `before` / `after` pair for a customer update, including
 * only the fields that were actually specified in the patch. Omitted
 * keys do not appear in either side of the diff — matches the spec's
 * "changed fields only" contract (data-model.md §5.10).
 */
function diffCustomerChange(
  priorRow: {
    name: string;
    phone: string | null;
    email: string | null;
    address: { street: string; zip: string; city: string } | null;
    notes: string | null;
  },
  patch: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    notes?: string | null;
  },
): { before: CustomerDiff; after: CustomerDiff } {
  const before: CustomerDiff = {};
  const after: CustomerDiff = {};
  if (patch.name !== undefined) {
    before.name = priorRow.name;
    after.name = patch.name;
  }
  if ('phone' in patch) {
    before.phone = priorRow.phone ?? null;
    after.phone = patch.phone ?? null;
  }
  if ('email' in patch) {
    before.email = priorRow.email ?? null;
    after.email = patch.email ?? null;
  }
  if ('address' in patch) {
    before.address = priorRow.address ?? null;
    after.address = patch.address ?? null;
  }
  if ('notes' in patch) {
    before.notes = priorRow.notes ?? null;
    after.notes = patch.notes ?? null;
  }
  return { before, after };
}
