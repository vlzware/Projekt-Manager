import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { AttachmentService } from '../services/AttachmentService.js';
import { notImplemented } from '../errors.js';

export function attachmentRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const service = new AttachmentService(db);
    void service;

    app.addHook('preHandler', authenticate);

    app.get(
      '/api/projects/:id/attachments',
      {
        preHandler: requirePermission('attachment:read'),
      },
      async (_request, _reply) => {
        throw notImplemented();
      },
    );

    app.post(
      '/api/projects/:id/attachments/init',
      {
        preHandler: requirePermission('attachment:write'),
      },
      async (_request, _reply) => {
        throw notImplemented();
      },
    );

    app.post(
      '/api/projects/:id/attachments/:attId/complete',
      {
        preHandler: requirePermission('attachment:write'),
      },
      async (_request, _reply) => {
        throw notImplemented();
      },
    );

    app.delete(
      '/api/projects/:id/attachments/:attId',
      {
        preHandler: requirePermission('attachment:delete'),
      },
      async (_request, _reply) => {
        throw notImplemented();
      },
    );

    app.get(
      '/api/projects/:id/attachments/:attId/download-url',
      {
        preHandler: requirePermission('attachment:read'),
      },
      async (_request, _reply) => {
        throw notImplemented();
      },
    );

    app.post(
      '/api/projects/:id/attachments/bulk-download',
      {
        preHandler: requirePermission('attachment:read'),
      },
      async (_request, _reply) => {
        throw notImplemented();
      },
    );
  };
}
