/**
 * Public push-configuration routes — api.md §14.2.10, ADR-0023.
 *
 * This plugin is unauthenticated on purpose: the VAPID public key is
 * intentionally public (the private half never leaves the server). A
 * separate plugin keeps the authenticated `push-subscriptions.ts`
 * hook (`app.addHook('preHandler', authenticate)`) from leaking onto
 * this route — Fastify's `preHandler` at the plugin level only
 * applies to routes registered inside the same plugin encapsulation.
 *
 * Operator-facing contract: set `VAPID_PUBLIC_KEY` in the deploy env
 * and the endpoint starts returning that value; leave it unset and
 * the endpoint returns `{ vapidPublicKey: null }` so the client
 * renders the "not configured" branch without a second env var to
 * keep in sync (see `src/pwa/pushClient.ts`).
 */

import type { FastifyInstance } from 'fastify';
import { getEnv } from '../config/env.js';

export function pushPublicRoutes() {
  return async function (app: FastifyInstance): Promise<void> {
    // ---------------------------------------------------------------
    // GET /api/push/vapid-public-key
    //
    // Unauthenticated. Returns `{ vapidPublicKey: string | null }`.
    // The value is either `VAPID_PUBLIC_KEY` as configured in the
    // server env, or `null` when any of the three VAPID env vars is
    // missing (dispatch is a no-op in that case anyway).
    //
    // Cache: 5 minutes. The key rotates only via deploy; clients can
    // safely re-fetch on the next subscribe attempt. The response is
    // non-user-specific so `cache-control: public` is appropriate —
    // intermediary caches (if any) may reuse it across sessions.
    // ---------------------------------------------------------------
    app.get('/api/push/vapid-public-key', async (_request, reply) => {
      const env = getEnv();
      const hasAllVapid =
        typeof env.VAPID_PUBLIC_KEY === 'string' &&
        env.VAPID_PUBLIC_KEY.length > 0 &&
        typeof env.VAPID_PRIVATE_KEY === 'string' &&
        env.VAPID_PRIVATE_KEY.length > 0 &&
        typeof env.VAPID_SUBJECT === 'string' &&
        env.VAPID_SUBJECT.length > 0;

      // We only surface the public key when the full triple is
      // configured. Returning the public key while the private half
      // is missing would let the client subscribe successfully and
      // the server silently drop every push — worse user-visible
      // signal than "not configured".
      const vapidPublicKey = hasAllVapid ? (env.VAPID_PUBLIC_KEY ?? null) : null;

      reply.header('cache-control', 'public, max-age=300');
      return reply.code(200).send({ vapidPublicKey });
    });

    // Non-GET verbs on the same path → explicit 405, not the default
    // 404. Web Push clients that accidentally POST to this path get a
    // meaningful response. Fastify's router does not auto-populate
    // `Allow` so we set it here.
    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/push/vapid-public-key',
      handler: async (_request, reply) => {
        reply.header('allow', 'GET');
        return reply
          .code(405)
          .send({ code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed on this endpoint.' });
      },
    });
  };
}
