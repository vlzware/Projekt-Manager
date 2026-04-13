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
import { customerRoutes } from './routes/customers.js';
import { customerBulkRoutes } from './routes/customers-bulk.js';
import { userRoutes } from './routes/users.js';
import { exportRoutes } from './routes/export.js';
import { extractRoutes } from './routes/extract.js';
import { getEnv } from './config/env.js';
import { AppError, rateLimited, serverError, validationError } from './errors.js';
import { STRINGS } from '../config/strings.js';

export interface AppOptions {
  logger?: boolean;
  db?: Database;
  /** Set false to disable rate limiting (useful in tests). Defaults to true. */
  rateLimit?: boolean;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Trust exactly one proxy hop — Caddy in production (terminating
    // TLS and forwarding to the app container), nothing in dev. With
    // trustProxy: true, Fastify would accept any X-Forwarded-For header
    // from any upstream, which would let a client spoof the rate-limit
    // key or the log-visible IP by setting X-Forwarded-For directly.
    // One hop is the tightest value that still gives the real client
    // IP through the Caddy → app chain. See consolidation review G F-4.
    trustProxy: 1,
  });

  // Global error handler — catches unhandled exceptions and wraps them
  // so internal details (stack traces, table names) never leak to clients.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }

    const fastifyErr = error as Error & { statusCode?: number; validation?: unknown[] };

    // Fastify's built-in JSON Schema validator (ajv) throws a FastifyError with
    // a `validation` array when the request body/params/querystring does not
    // conform to the route schema. Previously these fell through to serverError()
    // below, so every 400 Bad Request was rewritten as 500 SERVER_ERROR — hiding
    // the root cause from the client and tripping 5xx alerting on every malformed
    // request. Map them to a proper 422 VALIDATION_ERROR with the validation
    // details preserved so callers can display meaningful field-level feedback.
    if (fastifyErr.validation) {
      const err = validationError(STRINGS.errors.invalidInput, fastifyErr.validation);
      return reply.code(err.statusCode).send(err.toResponse());
    }

    // @fastify/rate-limit throws a vanilla Error with statusCode 429 when
    // a limit is exceeded. Without this branch it would fall through to
    // serverError() below and legitimate rate-limit responses would be
    // rewritten as 500 SERVER_ERROR — hiding the real reason from the
    // client and tripping any 5xx alerting. The plugin sets Retry-After
    // before throwing, so reply.code + send preserves the header.
    if (fastifyErr.statusCode === 429) {
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
  // HSTS enforces HTTPS (when TLS is active), X-Frame-Options blocks framing.
  // Reads from validated env (see env.ts) — not process.env — so ADR-0013
  // and the assertProductionSafe() guard in start.ts share a single source
  // of truth for ALLOW_INSECURE_HTTP. See consolidation review C-3.
  const insecureHttp = getEnv().ALLOW_INSECURE_HTTP === 'true';
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
        // Helmet defaults to adding upgrade-insecure-requests, which tells
        // browsers to rewrite every HTTP subresource URL to HTTPS. Over
        // plain HTTP this silently breaks all asset loads (JS, CSS, images).
        ...(insecureHttp ? { upgradeInsecureRequests: null } : {}),
      },
    },
    // Disable HSTS in HTTP-only evaluation mode — the header is meaningless
    // over plain HTTP and creates browser state conflicts when the same
    // browser later visits the HTTPS version (or vice versa).
    hsts: insecureHttp
      ? false
      : {
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
    app.register(customerRoutes(opts.db));
    app.register(customerBulkRoutes(opts.db));
    app.register(userRoutes(opts.db));
    app.register(exportRoutes(opts.db));
    app.register(extractRoutes(opts.db));
  }

  return app;
}
