/**
 * Authentication routes — login, logout, me, change-password.
 *
 * Routes are thin HTTP adapters: request parsing, response formatting,
 * cookie management, Fastify-specific concerns. Business logic lives
 * in AuthService.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { AUTH_CONFIG, RATE_LIMIT, getCookieSecure } from '../config/index.js';
import { AuthService } from '../services/AuthService.js';

export function authRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const authService = new AuthService(db);

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
          rateLimit: RATE_LIMIT.login,
        },
      },
      async (request, reply) => {
        const { username, password } = request.body as {
          username: string;
          password: string;
        };

        const result = await authService.login(username, password, request.ip, request.log);

        reply.setCookie('session', result.token, {
          httpOnly: true,
          secure: getCookieSecure(),
          sameSite: 'strict',
          path: '/',
          maxAge: AUTH_CONFIG.cookieMaxAgeSec,
        });
        return reply.code(200).send({ user: result.user });
      },
    );

    // ---------------------------------------------------------------
    // POST /api/auth/logout
    // ---------------------------------------------------------------
    app.post('/api/auth/logout', { preHandler: authenticate }, async (request, reply) => {
      const token = request.cookies.session;
      await authService.logout(token!, request.user!.id, request.ip, request.log);
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
        preHandler: [authenticate, requirePermission('auth:change-password')],
        schema: {
          body: {
            type: 'object',
            required: ['currentPassword', 'newPassword'],
            additionalProperties: false,
            properties: {
              currentPassword: { type: 'string', minLength: 1 },
              // maxLength here is a coarse payload-size bound only — the
              // real policy (min 8 chars, max 72 UTF-8 *bytes*, blocklist)
              // lives in config/password-policy.ts and runs in AuthService.
              // Using `maxLength: 72` here would be a trap because JSON
              // Schema maxLength counts characters, not bytes — see the
              // commit that added this comment for the full story.
              newPassword: { type: 'string', minLength: 1, maxLength: 1024 },
            },
          },
        },
        config: {
          rateLimit: RATE_LIMIT.passwordChange,
        },
      },
      async (request, reply) => {
        const { currentPassword, newPassword } = request.body as {
          currentPassword: string;
          newPassword: string;
        };

        await authService.changePassword(
          request.user!.id,
          request.user!.username,
          currentPassword,
          newPassword,
          request.cookies.session,
          request.ip,
          request.log,
        );

        return reply.code(200).send({ success: true });
      },
    );
  };
}
