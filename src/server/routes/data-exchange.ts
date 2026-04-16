/**
 * Unified data exchange routes. See ADR-0018.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { ExportService } from '../services/ExportService.js';
import { ImportService } from '../services/ImportService.js';
import type { Envelope, ImportOptions } from '../../domain/dataExchange.js';

const ENVELOPE_BODY_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'exported_at', 'customers', 'projects', 'project_workers'],
  properties: {
    schema_version: { type: 'integer' },
    exported_at: { type: 'string' },
    customers: { type: 'array' },
    projects: { type: 'array' },
    project_workers: { type: 'array' },
  },
} as const;

export function dataExchangeRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const exportService = new ExportService(db);
    const importService = new ImportService(db);

    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // GET /api/export
    // ---------------------------------------------------------------
    app.get(
      '/api/export',
      { preHandler: requirePermission('data:export') },
      async (request, reply) => {
        // Caller is guaranteed non-null after `authenticate` — thread it
        // through so ExportService can fail-fast if a scoped role ever
        // acquires `data:export` (tripwire for ADR-0019 bypass).
        const envelope = await exportService.export(request.user!);
        return reply.code(200).send(envelope);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/import
    // ---------------------------------------------------------------
    app.post(
      '/api/import',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              // Strict enum so a typo (TRUE, 1, yes, dryRun-camelCase) fails
              // closed with 422 rather than silently arming the destructive
              // path. Mirrors `override`'s safe-by-default posture.
              dry_run: { type: 'string', enum: ['true', 'false'] },
              override: { type: 'string', enum: ['true', 'false'] },
            },
          },
          body: ENVELOPE_BODY_SCHEMA,
        },
        preHandler: requirePermission('data:restore'),
      },
      async (request, reply) => {
        const query = request.query as { dry_run?: string; override?: string };
        const opts: ImportOptions = {
          dryRun: query.dry_run === 'true',
          override: query.override === 'true',
        };
        const envelope = request.body as Envelope;
        const result = await importService.import(envelope, opts);
        return reply.code(200).send(result);
      },
    );
  };
}
