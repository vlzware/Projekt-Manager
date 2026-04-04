/**
 * Session repository — database operations for the sessions table.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { sessions, users } from '../db/schema.js';

export type SessionRow = typeof sessions.$inferSelect;

export interface SessionWithUser {
  session: SessionRow;
  user: {
    id: string;
    username: string;
    displayName: string;
    roles: string[];
    email: string | null;
    active: boolean;
    passwordHash: string;
  };
}

/**
 * Create a new session for a user. Returns the session row including the token.
 */
export async function createSession(
  db: Database,
  userId: string,
  expiresAt: Date,
): Promise<SessionRow> {
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      expiresAt,
    })
    .returning();
  return rows[0]!;
}

/**
 * Find a session by token, joined with the user to check active status.
 */
export async function findSession(
  db: Database,
  token: string,
): Promise<SessionWithUser | null> {
  const rows = await db
    .select({
      session: sessions,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        roles: users.roles,
        email: users.email,
        active: users.active,
        passwordHash: users.passwordHash,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Delete a session by token (logout).
 */
export async function deleteSession(
  db: Database,
  token: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}

/**
 * Create an already-expired session (for testing).
 * Returns the token string.
 */
export async function createExpiredSession(
  db: Database,
  userId: string,
): Promise<string> {
  const expiredAt = new Date(Date.now() - 60_000); // 1 minute in the past
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      expiresAt: expiredAt,
    })
    .returning();
  return rows[0]!.token;
}
