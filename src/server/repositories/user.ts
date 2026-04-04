/**
 * User repository — database operations for the users table.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { users } from '../db/schema.js';

export type UserRow = typeof users.$inferSelect;

export async function findByUsername(
  db: Database,
  username: string,
): Promise<UserRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows[0] ?? null;
}

export async function findById(
  db: Database,
  id: string,
): Promise<UserRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateLastLogin(
  db: Database,
  id: string,
): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, id));
}

export async function deactivateUser(
  db: Database,
  id: string,
): Promise<void> {
  await db
    .update(users)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(users.id, id));
}

export async function changePassword(
  db: Database,
  id: string,
  newPasswordHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
    .where(eq(users.id, id));
}
