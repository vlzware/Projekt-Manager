/**
 * Session repository — database operations for the sessions table.
 */

import { randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
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
  const token = randomBytes(32).toString('hex');
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      token,
      expiresAt,
    })
    .returning();
  return rows[0]!;
}

/**
 * Find a session by token, joined with the user to check active status.
 */
export async function findSession(db: Database, token: string): Promise<SessionWithUser | null> {
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
export async function deleteSession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}

/**
 * Delete all sessions for a user, optionally excluding a specific token
 * (e.g. the current session on password change).
 */
export async function deleteSessionsByUserId(
  db: Database,
  userId: string,
  excludeToken?: string,
): Promise<void> {
  const condition = excludeToken
    ? and(eq(sessions.userId, userId), ne(sessions.token, excludeToken))
    : eq(sessions.userId, userId);
  await db.delete(sessions).where(condition);
}

/**
 * Delete all expired sessions. Intended to be called from a periodic
 * cleanup job or at startup.
 */
export async function deleteExpiredSessions(db: Database): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}
