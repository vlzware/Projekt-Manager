/**
 * Authentication routes — login, logout, me, change-password.
 */

import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../../domain/auth.js';
import { findByUsername } from '../repositories/user.js';
import {
  createSession,
  deleteSession,
} from '../repositories/session.js';
import { changePassword as changePasswordRepo } from '../repositories/user.js';
import { updateLastLogin } from '../repositories/user.js';
import { invalidCredentials, validationError } from '../errors.js';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware } from '../middleware/auth.js';

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export function authRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);

    // ---------------------------------------------------------------
    // POST /api/auth/login
    // ---------------------------------------------------------------
    app.post('/api/auth/login', {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    }, async (request, reply) => {
      const { username, password } = (request.body ?? {}) as {
        username?: string;
        password?: string;
      };

      if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
        throw validationError('Benutzername und Passwort sind erforderlich.');
      }

      const user = await findByUsername(db, username);

      // No information leakage: same error for nonexistent, wrong password, inactive
      if (!user) throw invalidCredentials();
      if (!user.active) throw invalidCredentials();

      const passwordValid = await verifyPassword(password, user.passwordHash);
      if (!passwordValid) throw invalidCredentials();

      // Create session
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      const session = await createSession(db, user.id, expiresAt);

      // Update last login
      await updateLastLogin(db, user.id);

      return reply.code(200).send({
        token: session.token,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          roles: user.roles,
          email: user.email,
        },
      });
    });

    // ---------------------------------------------------------------
    // POST /api/auth/logout
    // ---------------------------------------------------------------
    app.post(
      '/api/auth/logout',
      { preHandler: authenticate },
      async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (authHeader) {
          const token = authHeader.slice(7);
          await deleteSession(db, token);
        }
        return reply.code(200).send({ success: true });
      },
    );

    // ---------------------------------------------------------------
    // GET /api/auth/me
    // ---------------------------------------------------------------
    app.get(
      '/api/auth/me',
      { preHandler: authenticate },
      async (request, reply) => {
        return reply.code(200).send(request.user);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/auth/change-password
    // ---------------------------------------------------------------
    app.post(
      '/api/auth/change-password',
      { preHandler: authenticate },
      async (request, reply) => {
        const { currentPassword, newPassword } = (request.body ?? {}) as {
          currentPassword?: string;
          newPassword?: string;
        };

        if (!currentPassword || typeof currentPassword !== 'string' ||
            !newPassword || typeof newPassword !== 'string') {
          throw validationError('Aktuelles und neues Passwort sind erforderlich.');
        }

        const user = await findByUsername(db, request.user!.username);
        if (!user) throw invalidCredentials();

        // Verify current password
        const valid = await verifyPassword(currentPassword, user.passwordHash);
        if (!valid) throw invalidCredentials();

        // Validate new password
        if (!newPassword || newPassword.length < 8) {
          throw validationError(
            'Das neue Passwort muss mindestens 8 Zeichen lang sein.',
          );
        }

        // Hash and store
        const newHash = await hashPassword(newPassword);
        await changePasswordRepo(db, user.id, newHash);

        return reply.code(200).send({ success: true });
      },
    );
  };
}
