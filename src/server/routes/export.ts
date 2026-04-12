/**
 * Export routes — download project and customer data as JSON.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { ExportService } from '../services/ExportService.js';

export function exportRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const exportService = new ExportService(db);

    app.addHook('preHandler', authenticate);

    // GET /api/export/projects
    app.get(
      '/api/export/projects',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              status: { type: ['string', 'array'], items: { type: 'string' } },
              customerId: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: requirePermission('project:read'),
      },
      async (request, reply) => {
        const query = request.query as {
          status?: string | string[];
          customerId?: string;
        };
        const result = await exportService.exportProjects(query);
        return reply.code(200).send(result);
      },
    );

    // GET /api/export/customers
    app.get(
      '/api/export/customers',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              hasProjects: { type: 'string' },
            },
          },
        },
        preHandler: requirePermission('customer:read'),
      },
      async (request, reply) => {
        const query = request.query as { hasProjects?: string };
        const result = await exportService.exportCustomers(query);
        return reply.code(200).send(result);
      },
    );
  };
}
