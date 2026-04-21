/**
 * Attachment routes — control plane only. No byte traffic through the
 * app; uploads and downloads go directly to object storage via
 * presigned URLs (AC-221, api.md §14.2.11).
 *
 * The route shape is pinned by AC-221's structural check — do not add
 * a 7th route on `/api/projects/:id/attachments/**` without updating
 * the spec + AC first.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { AttachmentService, type DownloadVariant } from '../services/AttachmentService.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';

export function attachmentRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const env = getEnv();
    const storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
    });
    const service = new AttachmentService({ db, storage });

    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // GET /api/projects/:id/attachments — list (status=ready only)
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id/attachments',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('attachment:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const rows = await service.listForProject(request.user!, id);
        return reply.code(200).send({ data: rows });
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/attachments/init — create pending row
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/attachments/init',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            required: ['fileName', 'mimeType', 'sizeBytes', 'label'],
            // Deliberately permissive on extra properties so a stray
            // `originalKey` / `projectId` in the payload round-trips as
            // a silent discard (route + service never read them). The
            // dedicated test ("rejects client-supplied originalKey")
            // pins the observable: the row's originalKey is server-issued.
            additionalProperties: true,
            properties: {
              fileName: { type: 'string', minLength: 1 },
              mimeType: { type: 'string', minLength: 1 },
              sizeBytes: { type: 'integer', minimum: 1 },
              label: { type: 'string' },
              hasThumbnail: { type: 'boolean' },
            },
          },
        },
        preHandler: requirePermission('attachment:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          fileName: string;
          mimeType: string;
          sizeBytes: number;
          label: string;
          hasThumbnail?: boolean;
        };
        const result = await service.initUpload(
          request.user!,
          id,
          {
            fileName: body.fileName,
            mimeType: body.mimeType,
            sizeBytes: body.sizeBytes,
            // The service re-validates `label` against the closed enum;
            // the typing here is intentionally wide so invalid payloads
            // reach the validator path (AC-211 422 VALIDATION_ERROR).
            label: body.label as never,
            hasThumbnail: Boolean(body.hasThumbnail),
          },
          request.log,
          request.id ?? null,
        );
        return reply.code(201).send(result);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/attachments/:attId/complete — finalize
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/attachments/:attId/complete',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'attId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              attId: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: requirePermission('attachment:write'),
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        const attachment = await service.completeUpload(request.user!, id, attId, request.log);
        return reply.code(200).send(attachment);
      },
    );

    // ---------------------------------------------------------------
    // DELETE /api/projects/:id/attachments/:attId — hard-delete
    // ---------------------------------------------------------------
    app.delete(
      '/api/projects/:id/attachments/:attId',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'attId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              attId: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: requirePermission('attachment:delete'),
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        await service.deleteAttachment(request.user!, id, attId, request.log, request.id ?? null);
        return reply.code(204).send();
      },
    );

    // ---------------------------------------------------------------
    // GET /api/projects/:id/attachments/:attId/download-url — presigned GET
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id/attachments/:attId/download-url',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'attId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              attId: { type: 'string', format: 'uuid' },
            },
          },
          querystring: {
            type: 'object',
            properties: {
              variant: { type: 'string' },
            },
          },
        },
        preHandler: requirePermission('attachment:read'),
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        const q = request.query as { variant?: string };
        const variant = (q.variant ?? 'original') as DownloadVariant;
        const result = await service.issueDownloadUrl(request.user!, id, attId, variant);
        return reply.code(200).send(result);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/attachments/bulk-download — presigned zip
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/attachments/bulk-download',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            required: ['attachmentIds'],
            additionalProperties: false,
            properties: {
              attachmentIds: {
                type: 'array',
                // Length caps are enforced in the service so the
                // BULK_LIMIT_EXCEEDED branch has the spec'd shape.
                items: { type: 'string', format: 'uuid' },
              },
            },
          },
        },
        preHandler: requirePermission('attachment:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { attachmentIds: string[] };
        const result = await service.issueBulkDownloadUrl(request.user!, id, body.attachmentIds);
        return reply.code(200).send(result);
      },
    );
  };
}
