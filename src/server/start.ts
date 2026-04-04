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

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, 'db/migrations');
const distFolder = path.resolve(__dirname, '../../dist');

async function start(): Promise<void> {
  const { db, pool } = createDatabase();

  // Run database migrations (idempotent — Drizzle tracks applied migrations)
  await migrate(db, { migrationsFolder });

  // Seed data if the database is empty or SEED=true is set
  if (process.env.SEED === 'true') {
    await seed(db);
    console.log('Database seeded (SEED=true).');
  }

  const app = buildApp({ logger: true, db });

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

  await app.listen({ port: PORT, host: HOST });

  // Graceful shutdown
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
