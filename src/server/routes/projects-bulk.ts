/**
 * Bulk project import route.
 *
 * POST /api/projects/bulk/import
 * Accepts an array of project objects, validates each individually,
 * inserts valid ones, and returns a summary of imported count + errors.
 *
 * Requires authentication + 'project:create' permission.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { ProjectService } from '../services/ProjectService.js';
import type { BulkImportItem } from '../services/ProjectService.js';

export function projectBulkRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const projectService = new ProjectService(db);

    // Apply auth to all routes in this plugin
    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // POST /api/projects/bulk/import
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/bulk/import',
      {
        schema: {
          body: {
            type: 'object',
            required: ['projects'],
            properties: {
              projects: {
                type: 'array',
                // Hard cap to prevent resource-exhaustion from an unbounded
                // payload. 1000 comfortably covers realistic customer
                // imports (kickoff assumes 10-30 concurrent projects; a
                // full historical backlog for a small company stays well
                // under 1000). Revisit if real migrations need higher.
                // See consolidation review C-5.
                maxItems: 1000,
                items: { type: 'object' },
              },
            },
            additionalProperties: false,
          },
        },
        preHandler: requirePermission('project:create'),
      },
      async (request, reply) => {
        const { projects } = request.body as { projects: BulkImportItem[] };
        const result = await projectService.bulkImport(projects, request.user!.id, request.log);
        return reply.code(200).send(result);
      },
    );
  };
}
