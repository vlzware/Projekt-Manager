/**
 * Application factory.
 *
 * Builds a Fastify instance with database connection, auth middleware,
 * and all route plugins registered.
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Database } from './db/connection.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { projectBulkRoutes } from './routes/projects-bulk.js';
import { AppError, rateLimited, serverError } from './errors.js';

export interface AppOptions {
  logger?: boolean;
  db?: Database;
  /** Set false to disable rate limiting (useful in tests). Defaults to true. */
  rateLimit?: boolean;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
  });

  // Global error handler — catches unhandled exceptions and wraps them
  // so internal details (stack traces, table names) never leak to clients.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }

    // @fastify/rate-limit throws a vanilla Error with statusCode 429 when
    // a limit is exceeded. Without this branch it would fall through to
    // serverError() below and legitimate rate-limit responses would be
    // rewritten as 500 SERVER_ERROR — hiding the real reason from the
    // client and tripping any 5xx alerting. The plugin sets Retry-After
    // before throwing, so reply.code + send preserves the header.
    const statusCode = (error as Error & { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      const err = rateLimited();
      return reply.code(err.statusCode).send(err.toResponse());
    }

    app.log.error(error);
    const err = serverError();
    return reply.code(err.statusCode).send(err.toResponse());
  });

  // Cookie parsing — registered before all other plugins so
  // request.cookies is available in every route and hook.
  app.register(cookie);

  // Security headers — CSP allows only same-origin resources,
  // HSTS enforces HTTPS, X-Frame-Options blocks framing.
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      // 180 days — helmet's default. The previous value (2 years with
      // `preload: true`) was chosen with the browser HSTS preload list in
      // mind, but preload is a one-way commitment: removal from the list
      // takes months and requires a manual application. The project is
      // not yet ready for that commitment (LLM-generated code, not yet
      // independently audited — see ADR-0008). 180 days is long enough
      // that returning visitors always see HTTPS, short enough that a
      // future rollback is tractable. See #56 for the decision.
      maxAge: 15552000,
      includeSubDomains: true,
      preload: false,
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  // CORS — same-origin SPA served by Fastify, reject all cross-origin
  // requests. origin:false means no Access-Control-Allow-Origin header
  // is sent, so browsers block cross-origin fetches.
  app.register(cors, {
    origin: false,
  });

  // Rate limiting — registered globally so individual routes can apply
  // overrides via route-level config. Disabled in tests to avoid flaky
  // failures from rapid sequential requests.
  if (opts.rateLimit !== false) {
    app.register(rateLimit, {
      global: false, // Only routes with explicit config are limited
    });
  }

  if (opts.db) {
    app.register(authRoutes(opts.db));
    app.register(projectRoutes(opts.db));
    app.register(projectBulkRoutes(opts.db));
  }

  return app;
}
