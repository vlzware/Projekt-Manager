/**
 * User repository — database operations for the users table.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { users } from '../db/schema.js';

export type UserRow = typeof users.$inferSelect;

export async function findByUsername(db: Database, username: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return rows[0] ?? null;
}

export async function findById(db: Database, id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateLastLogin(db: Database, id: string): Promise<void> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
}

/**
 * Deactivate a user (soft-delete — data-model.md §6.9). `actorId` is
 * the UUID of the user performing the deactivation, or null when the
 * caller is a system action (seed, migration, test fixture) and no
 * human actor is available. Matches the audit-metadata contract in
 * data-model.md §5.5. See consolidation review B F-3 / round-2 B M-1.
 */
export async function deactivateUser(
  db: Database,
  id: string,
  actorId: string | null,
): Promise<void> {
  await db
    .update(users)
    .set({ active: false, updatedAt: new Date(), updatedBy: actorId })
    .where(eq(users.id, id));
}

/**
 * Store a new password hash. `actorId` is the UUID of the user
 * performing the change (currently the same user — self-service
 * password change — but a future admin-reset endpoint would pass
 * the admin's id). Matches the audit-metadata contract in
 * data-model.md §5.5. See consolidation review B F-3.
 */
export async function changePassword(
  db: Database,
  id: string,
  newPasswordHash: string,
  actorId: string | null,
): Promise<void> {
  await db
    .update(users)
    .set({
      passwordHash: newPasswordHash,
      updatedAt: new Date(),
      updatedBy: actorId,
    })
    .where(eq(users.id, id));
}
