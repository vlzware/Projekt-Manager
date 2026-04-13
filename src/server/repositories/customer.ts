/**
 * Customer repository — CRUD operations.
 */

import { eq, count, ilike } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { customers, projects } from '../db/schema.js';

/** Escape LIKE-pattern metacharacters so user input is treated literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

export type CustomerRow = typeof customers.$inferSelect;

export function toCustomerResponse(row: CustomerRow) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
  };
}

export async function listCustomers(
  db: Database,
  opts: { offset?: number; limit?: number; search?: string } = {},
): Promise<{ customers: ReturnType<typeof toCustomerResponse>[]; total: number }> {
  const baseCondition = opts.search
    ? ilike(customers.name, `%${escapeLike(opts.search)}%`)
    : undefined;

  const baseQuery = baseCondition
    ? db.select().from(customers).where(baseCondition)
    : db.select().from(customers);

  const paginatedQuery =
    opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery;

  const countQuery = baseCondition
    ? db.select({ value: count() }).from(customers).where(baseCondition)
    : db.select({ value: count() }).from(customers);

  const [rows, countResult] = await Promise.all([paginatedQuery, countQuery]);
  const total = countResult[0]?.value ?? 0;

  return {
    customers: rows.map(toCustomerResponse),
    total,
  };
}

export async function getCustomer(
  db: Database,
  id: string,
): Promise<(ReturnType<typeof toCustomerResponse> & { projectCount: number }) | null> {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  if (rows.length === 0) return null;

  const [countResult] = await db
    .select({ value: count() })
    .from(projects)
    .where(eq(projects.customerId, id));

  return {
    ...toCustomerResponse(rows[0]!),
    projectCount: countResult?.value ?? 0,
  };
}

export async function createCustomer(
  db: Database,
  data: {
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    notes?: string | null;
    createdBy?: string | null;
    updatedBy?: string | null;
  },
): Promise<ReturnType<typeof toCustomerResponse>> {
  const rows = await db
    .insert(customers)
    .values({
      name: data.name,
      phone: data.phone ?? null,
      email: data.email ?? null,
      address: data.address ?? null,
      notes: data.notes ?? null,
      createdBy: data.createdBy ?? null,
      updatedBy: data.updatedBy ?? null,
    })
    .returning();

  return toCustomerResponse(rows[0]!);
}

export async function updateCustomer(
  db: Database,
  id: string,
  userId: string,
  data: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    notes?: string | null;
  },
): Promise<ReturnType<typeof toCustomerResponse> | null> {
  const setClause: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: userId,
  };
  if (data.name !== undefined) setClause.name = data.name;
  if ('phone' in data) setClause.phone = data.phone;
  if ('email' in data) setClause.email = data.email;
  if ('address' in data) setClause.address = data.address;
  if ('notes' in data) setClause.notes = data.notes;

  const rows = await db.update(customers).set(setClause).where(eq(customers.id, id)).returning();

  if (rows.length === 0) return null;
  return toCustomerResponse(rows[0]!);
}

export async function deleteCustomer(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(customers)
    .where(eq(customers.id, id))
    .returning({ id: customers.id });
  return rows.length > 0;
}

/**
 * Find customers by exact name match (case-insensitive, trimmed).
 * Returns an array so the caller can detect ambiguous matches.
 * Uses ILIKE with escaped metacharacters for exact case-insensitive match.
 */
export async function findCustomersByName(db: Database, name: string): Promise<CustomerRow[]> {
  return db
    .select()
    .from(customers)
    .where(ilike(customers.name, escapeLike(name.trim())));
}

/** @deprecated Use findCustomersByName (plural) for ambiguity detection. */
export async function findCustomerByName(db: Database, name: string): Promise<CustomerRow | null> {
  const rows = await findCustomersByName(db, name);
  return rows[0] ?? null;
}
