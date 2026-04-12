/**
 * Customer bulk import route.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { CustomerService } from '../services/CustomerService.js';

export function customerBulkRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const customerService = new CustomerService(db);

    app.addHook('preHandler', authenticate);

    // POST /api/customers/bulk/import
    app.post(
      '/api/customers/bulk/import',
      {
        schema: {
          body: {
            type: 'object',
            required: ['customers'],
            properties: {
              customers: {
                type: 'array',
                maxItems: 1000,
                items: { type: 'object' },
              },
            },
          },
        },
        preHandler: requirePermission('customer:write'),
      },
      async (request, reply) => {
        const { customers } = request.body as { customers: Record<string, unknown>[] };
        const result = await customerService.bulkImport(customers, request.user!.id, request.log);
        return reply.code(200).send(result);
      },
    );
  };
}
