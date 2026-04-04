/**
 * Application factory.
 *
 * Builds a Fastify instance with database connection, auth middleware,
 * and all route plugins registered.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Database } from './db/connection.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { AppError, serverError } from './errors.js';

export interface AppOptions {
  logger?: boolean;
  db?: Database;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
  });

  // Global error handler — catches unhandled exceptions and wraps them
  // so internal details (stack traces, table names) never leak to clients.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    app.log.error(error);
    const err = serverError();
    return reply.code(err.statusCode).send(err.toResponse());
  });

  if (opts.db) {
    app.register(authRoutes(opts.db));
    app.register(projectRoutes(opts.db));
  }

  return app;
}
