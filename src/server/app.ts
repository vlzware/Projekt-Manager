/**
 * Application factory.
 *
 * Stub: returns a bare Fastify instance with no routes registered.
 * Tests that hit endpoints will get 404s, which is the correct failure
 * mode at this stage (TDD red phase).
 *
 * Implementation will register routes, plugins, and database connections
 * once the backend stack is in place.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

export interface AppOptions {
  logger?: boolean;
  // TODO: database connection config
  // TODO: object storage config
  // TODO: session config (duration, secret)
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
  });

  // TODO: register database plugin (Drizzle + PostgreSQL)
  // TODO: register auth plugin (session management)
  // TODO: register route plugins:
  //   - POST /api/auth/login
  //   - POST /api/auth/logout
  //   - GET  /api/auth/me
  //   - GET  /api/projects
  //   - GET  /api/projects/:id
  //   - POST /api/projects/:id/transition/forward
  //   - POST /api/projects/:id/transition/backward
  //   - PATCH /api/projects/:id/dates
  //   - POST /api/auth/change-password

  return app;
}
