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

export interface AppOptions {
  logger?: boolean;
  db?: Database;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
  });

  if (opts.db) {
    app.register(authRoutes(opts.db));
    app.register(projectRoutes(opts.db));
  }

  return app;
}
