/**
 * Production entry point.
 *
 * Boots the Fastify application, runs database migrations,
 * optionally seeds data, and starts listening.
 *
 * Executed via: node --import tsx src/server/start.ts
 */

import { buildApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

async function start(): Promise<void> {
  const app = buildApp({ logger: true });

  // TODO: Run database migrations on startup (Drizzle migrate)
  // TODO: Seed data if DB is empty or SEED=true env var is set

  // TODO: Serve static files from dist/ directory.
  // Requires @fastify/static — the backend implementation agent
  // will register this plugin in buildApp() or here once the
  // package is added. Example:
  //
  //   import fastifyStatic from '@fastify/static';
  //   import { fileURLToPath } from 'url';
  //   import path from 'path';
  //
  //   const __dirname = path.dirname(fileURLToPath(import.meta.url));
  //   app.register(fastifyStatic, {
  //     root: path.join(__dirname, '../../dist'),
  //     wildcard: false,
  //   });
  //
  //   // SPA fallback: serve index.html for non-API routes
  //   app.setNotFoundHandler((req, reply) => {
  //     if (!req.url.startsWith('/api')) {
  //       return reply.sendFile('index.html');
  //     }
  //     reply.code(404).send({ error: 'Not found' });
  //   });

  await app.listen({ port: PORT, host: HOST });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
