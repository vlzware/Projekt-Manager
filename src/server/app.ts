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
import { customerRoutes } from './routes/customers.js';
import { userRoutes } from './routes/users.js';
import { dataExchangeRoutes } from './routes/data-exchange.js';
import { extractRoutes } from './routes/extract.js';
import { backupRoutes } from './routes/backup.js';
import { auditRoutes } from './routes/audit.js';
import { notificationRuleRoutes } from './routes/notification-rules.js';
import { pushSubscriptionRoutes } from './routes/push-subscriptions.js';
import { pushPublicRoutes } from './routes/push.js';
import { registerNotificationPublisher } from './services/notification-publisher.js';
import { noopPushDispatcher, type PushDispatcher } from './services/PushDispatcher.js';
import { WebPushDispatcher } from './services/WebPushDispatcher.js';
import { getEnv } from './config/env.js';
import { AppError, rateLimited, serverError, validationError } from './errors.js';
import { STRINGS } from '../config/strings.js';

export interface AppOptions {
  logger?: boolean;
  db?: Database;
  /** Set false to disable rate limiting (useful in tests). Defaults to true. */
  rateLimit?: boolean;
}

/**
 * Pick the push dispatcher at boot. Real `WebPushDispatcher` wins only
 * when the full VAPID triple is configured; any missing value falls
 * back to `noopPushDispatcher`. The fallback warn is a single-line
 * startup message so an operator can spot a misconfigured deploy
 * without silently breaking push delivery.
 *
 * Exported for tests that want to exercise the selection logic
 * without wiring a full Fastify instance.
 */
export function selectPushDispatcher(logger?: {
  warn: (msg: string) => void;
  info?: (msg: string) => void;
}): PushDispatcher {
  const env = getEnv();
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (publicKey && privateKey && subject) {
    logger?.info?.(`Push dispatcher: WebPushDispatcher active (VAPID subject=${subject}).`);
    return new WebPushDispatcher({ publicKey, privateKey, subject });
  }
  logger?.warn(
    'Push dispatcher: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT missing — ' +
      'falling back to no-op dispatcher. Web Push delivery is disabled.',
  );
  return noopPushDispatcher;
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
    app.register(customerRoutes(opts.db));
    app.register(userRoutes(opts.db));
    app.register(dataExchangeRoutes(opts.db));
    app.register(extractRoutes(opts.db));
    app.register(backupRoutes(opts.db));
    app.register(auditRoutes(opts.db));
    app.register(notificationRuleRoutes(opts.db));
    app.register(pushSubscriptionRoutes(opts.db));
    // The VAPID public-key endpoint is unauthenticated (the public key
    // is public by design). Keeping it in its own plugin isolates it
    // from the authenticated push-subscriptions plugin's preHandler
    // hook — see routes/push.ts header for the encapsulation note.
    app.register(pushPublicRoutes());

    // Wire the notification publisher to the audit bus. Dispatcher
    // selection: real `WebPushDispatcher` when all three VAPID env
    // vars are present, else `noopPushDispatcher` with a one-line
    // startup warn. This composition happens AFTER the audit-
    // publisher logger is set in start.ts, so a throwing subscriber
    // surfaces through that logger rather than being swallowed (AC-
    // 183). Tests register the noop silently (logger disabled).
    const dispatcher = selectPushDispatcher(app.log);
    registerNotificationPublisher({ db: opts.db, dispatcher });
  }

  return app;
}
