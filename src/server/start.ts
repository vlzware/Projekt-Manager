/**
 * Production entry point.
 *
 * Boots the Fastify application, runs database migrations,
 * optionally seeds data, serves the static frontend, and starts listening.
 *
 * Executed via: node --import tsx src/server/start.ts
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fastifyStatic from '@fastify/static';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from './app.js';
import { createDatabase } from './db/connection.js';
import { seed } from './seed.js';
import { deleteExpiredSessions } from './repositories/session.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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
  // --- Production safety checks (before any I/O) ---
  if (IS_PRODUCTION) {
    rejectDevCredentials();
  }

  const { db, pool } = createDatabase();

  // Run database migrations (idempotent — Drizzle tracks applied migrations)
  await migrate(db, { migrationsFolder });

  // Seed data — never in production
  if (process.env.SEED === 'true') {
    if (IS_PRODUCTION) {
      console.warn(
        'WARNING: SEED=true is set but NODE_ENV=production — skipping seed to protect production data.',
      );
    } else {
      await seed(db);
      console.log('Database seeded (SEED=true).');
    }
  }

  // Clean up expired sessions on startup
  const deleted = await deleteExpiredSessions(db);
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} expired sessions.`);
  }

  const app = buildApp({ logger: true, db });

  // Health-check endpoint (outside auth-guarded routes)
  app.get('/api/health', async (_request, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  // Serve the Vite-built frontend from dist/
  await app.register(fastifyStatic, {
    root: distFolder,
    wildcard: false,
  });

  // SPA fallback: serve index.html for non-API routes
  app.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ code: 'NOT_FOUND', message: 'Nicht gefunden.' });
  });

  // Graceful shutdown — registered before listen to avoid a window
  // where SIGTERM during startup causes an unclean exit.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }

  await app.listen({ port: PORT, host: HOST });
}

start().catch((err) => {
  console.error('Failed to start server:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
