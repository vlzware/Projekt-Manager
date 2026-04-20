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
import { AUTH_CONFIG, getRateLimit, getCookieSecure } from '../config/index.js';
import { AuthService } from '../services/AuthService.js';
import { BackupStatusService } from '../services/BackupStatusService.js';
import type { BackupStatus } from '../../domain/backupBadge.js';

export function authRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const authService = new AuthService(db);
    // Pass the app logger so the service can emit structured warnings on
    // DB-unreachable vs programmer-error reads (AC-171 misleading-state
    // guard — see BackupStatusService.read).
    const backupStatusService = new BackupStatusService(db, {
      warn: (obj, msg) => app.log.warn(obj, msg),
    });

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
          rateLimit: getRateLimit().login,
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
    //
    // Returns the authenticated user profile. For callers with role
    // `owner`, the response also carries the current `backupStatus`
    // (verification.md AC-170 — badge visible only to owner on the
    // authenticated surface; other roles get no `backupStatus` key).
    // This reuses the existing `/api/auth/me` endpoint rather than
    // adding a new REST surface (per ADR-0020 / architecture.md §11.10).
    //
    // Design note — login-screen badge: AC-170 also requires the badge
    // to render on the unauthenticated login screen. The project's
    // login is a SPA view (not a server-rendered template), so the
    // "server-render into HTML + inline JSON" approach in the task
    // description does not match this codebase. Stream 3 (UI) owns the
    // login-screen wiring; if an unauthenticated status endpoint is
    // needed, that is a separate piece of work — it is not added here
    // so the route surface stays within the "no new endpoints" rule.
    // ---------------------------------------------------------------
    app.get('/api/auth/me', { preHandler: authenticate }, async (request, reply) => {
      const { id, username, displayName, roles, email, themePreference } = request.user!;
      const response: {
        user: {
          id: string;
          username: string;
          displayName: string;
          roles: string[];
          email: string | null;
          themePreference: string;
        };
        backupStatus?: BackupStatus;
      } = {
        user: { id, username, displayName, roles, email, themePreference },
      };

      if (roles.includes('owner')) {
        const status = await backupStatusService.read();
        if (status !== null) {
          response.backupStatus = status;
        }
        // Misleading-state guard (AC-171): if the status row is
        // unreachable, the omitted `backupStatus` field drives the
        // client-side `deriveBadgeState(undefined, ...)` branch which
        // renders "Status unbekannt" — the unknown state surfaces
        // explicitly rather than silently hiding the badge.
      }

      // Enveloped under `user` to match POST /api/auth/login — both
      // endpoints return the same user profile shape, so a single
      // `{ user: AuthUser }` contract lets typed clients share types.
      // See iteration-5 consolidation review E F-7.
      return reply.code(200).send(response);
    });

    // ---------------------------------------------------------------
    // PATCH /api/auth/me — self-scope preference update (api.md §14.2.1)
    //
    // Body is open-ended by design: future iterations may add further
    // user-controlled fields alongside themePreference. The JSON-Schema
    // pin below enforces the allowed set, so any unknown key is
    // rejected via the standard Fastify validation path (VALIDATION_ERROR).
    // ---------------------------------------------------------------
    app.patch(
      '/api/auth/me',
      {
        preHandler: authenticate,
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              themePreference: {
                type: 'string',
                // data-model.md §5.7 — the accepted set. Kept in sync with
                // the DB CHECK `users_valid_theme_preference` (migration 0013).
                enum: ['light', 'dark', 'system'],
              },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body as { themePreference?: 'light' | 'dark' | 'system' };
        const updated = await authService.updateSelfPreferences(
          request.user!.id,
          body,
          request.log,
          request.id ?? null,
        );
        // Same envelope shape as GET /api/auth/me and login — a typed
        // client consumes one response type across all three endpoints.
        return reply.code(200).send({
          user: {
            id: updated.id,
            username: updated.username,
            displayName: updated.displayName,
            roles: updated.roles,
            email: updated.email,
            themePreference: updated.themePreference,
          },
        });
      },
    );

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
          rateLimit: getRateLimit().passwordChange,
        },
      },
      async (request, reply) => {
        const { currentPassword, newPassword } = request.body as {
          currentPassword: string;
          newPassword: string;
        };

        await authService.changePassword(
          request.user!.id,
          currentPassword,
          newPassword,
          request.cookies.session,
          request.ip,
          request.log,
          request.id ?? null,
        );

        return reply.code(200).send({ success: true });
      },
    );
  };
}
