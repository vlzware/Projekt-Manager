/**
 * Authentication routes — login, logout, me, change-password.
 */

import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../password.js';
import { findByUsername } from '../repositories/user.js';
import { createSession, deleteSession, deleteSessionsByUserId } from '../repositories/session.js';
import { changePassword as changePasswordRepo } from '../repositories/user.js';
import { updateLastLogin } from '../repositories/user.js';
import { invalidCredentials, validationError } from '../errors.js';
import { isCommonPassword } from '../data/common-passwords.js';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware } from '../middleware/auth.js';

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Pre-computed bcrypt hash used to equalise timing when user is not found.
// The actual plaintext is irrelevant — we only need bcrypt to burn the same
// CPU time as a real comparison.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export function authRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);

    // ---------------------------------------------------------------
    // POST /api/auth/login
    // ---------------------------------------------------------------
    app.post(
      '/api/auth/login',
      {
        schema: {
          body: {
            type: 'object',
            required: ['username', 'password'],
            additionalProperties: false,
            properties: {
              username: { type: 'string', minLength: 1 },
              password: { type: 'string', minLength: 1 },
            },
          },
        },
        config: {
          rateLimit: {
            max: 5,
            timeWindow: '1 minute',
          },
        },
      },
      async (request, reply) => {
        const { username, password } = request.body as {
          username: string;
          password: string;
        };

        const user = await findByUsername(db, username);

        // Timing side-channel mitigation: burn the same bcrypt time
        // regardless of whether the user exists.
        if (!user) {
          await verifyPassword(password, DUMMY_HASH);
          request.log.info({ username, ip: request.ip }, 'login_failure');
          throw invalidCredentials();
        }
        if (!user.active) {
          await verifyPassword(password, DUMMY_HASH);
          request.log.info({ username, ip: request.ip }, 'login_failure');
          throw invalidCredentials();
        }

        const passwordValid = await verifyPassword(password, user.passwordHash);
        if (!passwordValid) {
          request.log.info({ username, ip: request.ip }, 'login_failure');
          throw invalidCredentials();
        }

        // Create session
        const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
        const session = await createSession(db, user.id, expiresAt);

        // Update last login
        await updateLastLogin(db, user.id);

        request.log.info({ username, ip: request.ip }, 'login_success');
        reply.setCookie('session', session.token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/',
          maxAge: 86400,
        });
        return reply.code(200).send({
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            roles: user.roles,
            email: user.email,
          },
        });
      },
    );

    // ---------------------------------------------------------------
    // POST /api/auth/logout
    // ---------------------------------------------------------------
    app.post('/api/auth/logout', { preHandler: authenticate }, async (request, reply) => {
      const token = request.cookies.session;
      if (token) {
        await deleteSession(db, token);
      }
      request.log.info({ userId: request.user!.id, ip: request.ip }, 'logout');
      reply.clearCookie('session', { path: '/' });
      return reply.code(200).send({ success: true });
    });

    // ---------------------------------------------------------------
    // GET /api/auth/me
    // ---------------------------------------------------------------
    app.get('/api/auth/me', { preHandler: authenticate }, async (request, reply) => {
      const { id, username, displayName, roles, email } = request.user!;
      return reply.code(200).send({ id, username, displayName, roles, email });
    });

    // ---------------------------------------------------------------
    // POST /api/auth/change-password
    // ---------------------------------------------------------------
    app.post(
      '/api/auth/change-password',
      {
        preHandler: authenticate,
        schema: {
          body: {
            type: 'object',
            required: ['currentPassword', 'newPassword'],
            additionalProperties: false,
            properties: {
              currentPassword: { type: 'string', minLength: 1 },
              newPassword: { type: 'string', minLength: 8, maxLength: 72 },
            },
          },
        },
        config: {
          rateLimit: {
            max: 5,
            timeWindow: '1 minute',
          },
        },
      },
      async (request, reply) => {
        const { currentPassword, newPassword } = request.body as {
          currentPassword: string;
          newPassword: string;
        };

        const user = await findByUsername(db, request.user!.username);
        if (!user) throw invalidCredentials();

        // Verify current password
        const valid = await verifyPassword(currentPassword, user.passwordHash);
        if (!valid) throw invalidCredentials();

        // Check blocklist
        if (isCommonPassword(newPassword)) {
          throw validationError(
            'Dieses Passwort ist zu häufig. Bitte ein sichereres Passwort wählen.',
          );
        }

        // Hash and store
        const newHash = await hashPassword(newPassword);
        await changePasswordRepo(db, user.id, newHash);

        // Invalidate all other sessions (keep the current one alive)
        const currentToken = request.cookies.session;
        await deleteSessionsByUserId(db, user.id, currentToken);

        request.log.info({ userId: request.user!.id, ip: request.ip }, 'password_change');
        return reply.code(200).send({ success: true });
      },
    );
  };
}
