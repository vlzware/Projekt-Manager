/**
 * Realtime invalidation channel — `GET /api/events` (ADR-0025,
 * api.md §14.2.13, AC-268, AC-269).
 *
 * Single multiplexed Server-Sent Events response. The handler accepts
 * an authenticated session, opens an indefinite `text/event-stream`,
 * subscribes the connection to the in-process bus
 * (`src/server/sse/bus.ts`), arms a heartbeat timer, and tears down on
 * connection close. Authorization is at the consumer endpoints the
 * client refetches, not at the event — so the route applies the same
 * `authenticate` preHandler as every other gated `/api/*` plugin and
 * does not narrow further by role.
 *
 * Method gate: `POST` / `PUT` / `PATCH` / `DELETE` return 405 with
 * `Allow: GET`, mirroring `storage-usage.ts`. Without an explicit
 * handler Fastify would answer 404 on these verbs, which the spec
 * (verification.md §15.28) does not allow.
 *
 * The 25-second heartbeat is configurable via `SSE_HEARTBEAT_INTERVAL_MS`
 * — see `src/server/config/env.ts`. Each connection runs its own
 * `setInterval` (architecture.md §11.13: "Independent per connection;
 * not coordinated across the subscriber set") and `unref()`s the timer
 * so a held connection cannot block process shutdown.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { subscribe, unsubscribe, type SseConnection } from '../sse/bus.js';
import { getEnv } from '../config/env.js';

const HEARTBEAT_FRAME = ': keepalive\n\n';

export function eventsRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const heartbeatIntervalMs = getEnv().SSE_HEARTBEAT_INTERVAL_MS;

    app.addHook('preHandler', authenticate);

    app.get('/api/events', async (request, reply) => {
      // Stream headers — explicitly NOT setting Cache-Control. The
      // protocol is non-cacheable per WHATWG SSE; Fastify's default
      // cache-control behaviour is silent on this route because we
      // bypass `reply.send()`.
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();
      // Hand the response off to the route — Fastify must not try to
      // close it on its own when the async handler returns.
      reply.hijack();

      const conn: SseConnection = {
        write(chunk: string): void {
          reply.raw.write(chunk);
        },
      };
      subscribe(conn);

      const heartbeat = setInterval(() => {
        // A failed write here means the socket is gone; the close
        // handler below will fire and run the unsubscribe. No need to
        // double-tear-down on the timer path.
        try {
          reply.raw.write(HEARTBEAT_FRAME);
        } catch {
          /* socket gone — close handler tears down */
        }
      }, heartbeatIntervalMs);
      heartbeat.unref();

      const teardown = (): void => {
        clearInterval(heartbeat);
        unsubscribe(conn);
      };
      // `close` fires on tab close, navigation, network drop. `error`
      // covers transport faults that don't trigger a clean close. We
      // do not detach these listeners because the request object is
      // garbage-collected once the connection ends — leaving them
      // attached costs nothing.
      request.raw.on('close', teardown);
      request.raw.on('error', teardown);
    });

    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/events',
      handler: async (_request, reply) => {
        reply.header('allow', 'GET');
        return reply.code(405).send({
          code: 'METHOD_NOT_ALLOWED',
          message: 'Only GET is allowed on this endpoint.',
        });
      },
    });
  };
}
