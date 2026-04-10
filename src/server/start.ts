/**
 * Production entry point.
 *
 * Boots the Fastify application, runs database migrations,
 * optionally seeds data, serves the static frontend, and starts listening.
 *
 * Executed via: node --import tsx src/server/start.ts
 */

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fastifyStatic from '@fastify/static';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { STRINGS } from '../config/strings.js';
import { buildApp } from './app.js';
import { bootstrapAdminIfEmpty } from './bootstrap.js';
import { validateEnv } from './config/env.js';
import { createDatabase } from './db/connection.js';
import { probeHealth } from './health.js';
import { seed } from './seed.js';
import { deleteExpiredSessions } from './repositories/session.js';
import { createStorageClient } from './storage/client.js';

const HOST = '0.0.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, 'db/migrations');
const distFolder = path.resolve(__dirname, '../../dist');

/** Known dev-default credentials that must not reach production. */
const DEV_DEFAULTS: ReadonlyArray<{ envVar: string; values: string[] }> = [
  { envVar: 'POSTGRES_PASSWORD', values: ['postgres', 'devpassword'] },
  { envVar: 'MINIO_ROOT_USER', values: ['minioadmin'] },
  { envVar: 'MINIO_ROOT_PASSWORD', values: ['minioadmin'] },
];

/**
 * Refuse to start in production when any credential still uses a
 * well-known development default.
 */
function rejectDevCredentials(): void {
  for (const { envVar, values } of DEV_DEFAULTS) {
    const current = process.env[envVar];
    if (current !== undefined && values.includes(current)) {
      throw new Error(
        `Refusing to start: ${envVar} is set to the dev default "${current}". ` +
          'Set a secure value for production.',
      );
    }
  }
}

async function start(): Promise<void> {
  // --- Validate environment (fail fast before any I/O) ---
  const env = validateEnv();
  const isProduction = env.NODE_ENV === 'production';

  // --- Production safety checks ---
  if (isProduction) {
    rejectDevCredentials();
    if (env.ALLOW_INSECURE_HTTP === 'true') {
      throw new Error(
        'Refusing to start: ALLOW_INSECURE_HTTP=true in production. ' +
          'This disables cookie security. Remove ALLOW_INSECURE_HTTP or set NODE_ENV=development.',
      );
    }
  }

  if (env.ALLOW_INSECURE_HTTP === 'true') {
    console.warn(
      'WARNING: ALLOW_INSECURE_HTTP=true — cookie Secure flag is OFF. ' +
        'Do not use with real users or real data. See docs/ops/http-only-evaluation.md.',
    );
  }

  const { db, pool } = createDatabase();

  // Run database migrations (idempotent — Drizzle tracks applied migrations)
  await migrate(db, { migrationsFolder });

  // Seed data — never in production.
  // SEED=true  → seed only if database is empty (safe default for dev)
  // SEED=force → wipe and re-seed (when seed data structure changes)
  if (env.SEED === 'true' || env.SEED === 'force') {
    if (isProduction) {
      console.warn(
        'WARNING: SEED is set but NODE_ENV=production — skipping seed to protect production data.',
      );
    } else {
      await seed(db, { force: env.SEED === 'force' });
    }
  }

  // First-run admin bootstrap (ADR-0010 / issue #57). Runs AFTER migrate
  // and BEFORE app.listen — see AC-B7. Any thrown error propagates to the
  // start().catch(…) handler below, which exits non-zero.
  await bootstrapAdminIfEmpty(
    db,
    {
      username: env.BOOTSTRAP_ADMIN_USERNAME,
      password: env.BOOTSTRAP_ADMIN_PASSWORD,
      displayName: env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
    },
    { warn: (m) => console.warn(m), error: (m) => console.error(m) },
  );

  // Clean up expired sessions on startup
  const deleted = await deleteExpiredSessions(db);
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} expired sessions.`);
  }

  const app = buildApp({ logger: true, db });

  // Storage client for the health probe. Instantiated once at startup and
  // reused across health requests. The existing routes do not use storage
  // yet (walking skeleton), but #48 still wants MinIO liveness surfaced by
  // /api/health so operational outages show up before they cascade.
  const storageClient = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
  });

  // Health-check endpoint (outside auth-guarded routes). Real probe — runs
  // a trivial DB query and a HeadBucket against MinIO. Returns 503 if
  // either check fails, so the Docker healthcheck, smoke-test scripts, and
  // any future load balancer all see the actual state of the app's
  // dependencies instead of a hard-coded `ok`. See #48.
  app.get('/api/health', async (_request, reply) => {
    const health = await probeHealth(pool, storageClient);
    const code = health.status === 'ok' ? 200 : 503;
    return reply.code(code).send(health);
  });

  // Serve the Vite-built frontend from dist/ (production).
  // In dev, Vite's dev server handles the frontend via proxy.
  if (existsSync(distFolder)) {
    await app.register(fastifyStatic, {
      root: distFolder,
      wildcard: false,
    });

    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler((req, reply) => {
      if (!req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ code: 'NOT_FOUND', message: STRINGS.errors.notFound('Ressource') });
    });
  } else if (isProduction) {
    throw new Error(
      `dist/ not found at ${distFolder}. Run 'npm run build' before starting in production.`,
    );
  } else {
    app.setNotFoundHandler((_req, reply) => {
      reply.code(404).send({ code: 'NOT_FOUND', message: STRINGS.errors.notFound('Ressource') });
    });
  }

  // Graceful shutdown — registered before listen to avoid a window
  // where SIGTERM during startup causes an unclean exit.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }

  await app.listen({ port: env.PORT, host: HOST });
}

start().catch((err) => {
  console.error('Failed to start server:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
