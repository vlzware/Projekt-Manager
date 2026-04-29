/**
 * Attachment routes — control plane only. No byte traffic through the
 * app; uploads and downloads go directly to object storage via
 * presigned URLs (AC-221, api.md §14.2.11).
 *
 * The route shape is pinned by AC-221's structural check — do not add
 * a 9th route on `/api/projects/:id/attachments/**` without updating
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
      publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
      region: env.STORAGE_REGION,
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
            required: ['fileName', 'mimeType', 'sizeBytes', 'contentMd5', 'label'],
            // Strict shape — unknown fields are a 422 at the schema gate.
            // Closes the foot-gun where a stray `versionId` / `originalKey`
            // / `projectId` could silently land in the request and
            // pollute future readers; the route + service never read
            // them today, but `additionalProperties: false` is the
            // canonical input boundary.
            additionalProperties: false,
            properties: {
              fileName: { type: 'string', minLength: 1 },
              mimeType: { type: 'string', minLength: 1 },
              sizeBytes: { type: 'integer', minimum: 1 },
              // RFC 1864 base64 of MD5 (16-byte digest → 24 chars,
              // ending `==`). Position 22 carries only 2 significant
              // bits, so only `[AQgw]` are valid there — the broader
              // `[A-Za-z0-9+/]` would accept malformed values.
              // Service re-validates with the same regex; schema-level
              // pattern keeps a malformed payload from reaching the
              // service layer's state-machine setup.
              contentMd5: { type: 'string', pattern: '^[A-Za-z0-9+/]{21}[AQgw]==$' },
              label: { type: 'string' },
              hasThumbnail: { type: 'boolean' },
              // Upper bound is enforced server-side by `perThumbCapBytes`
              // because the env override may shift the cap at runtime; a
              // schema-level `maximum` would freeze it at deploy time.
              thumbSizeBytes: { type: 'integer', minimum: 1 },
              thumbContentMd5: { type: 'string', pattern: '^[A-Za-z0-9+/]{21}[AQgw]==$' },
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
          contentMd5: string;
          label: string;
          hasThumbnail?: boolean;
          thumbSizeBytes?: number;
          thumbContentMd5?: string;
        };
        const result = await service.initUpload(
          request.user!,
          id,
          {
            fileName: body.fileName,
            mimeType: body.mimeType,
            sizeBytes: body.sizeBytes,
            contentMd5: body.contentMd5,
            // The service re-validates `label` against the closed enum;
            // the typing here is intentionally wide so invalid payloads
            // reach the validator path (AC-211 422 VALIDATION_ERROR).
            label: body.label as never,
            hasThumbnail: Boolean(body.hasThumbnail),
            thumbSizeBytes: body.thumbSizeBytes,
            thumbContentMd5: body.thumbContentMd5,
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
    // DELETE /api/projects/:id/attachments/:attId — soft-hide
    // (ADR-0022; the row moves to status='hidden' and is recoverable
    // via the Papierkorb restore endpoint until lifecycle reap.)
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
        preHandler: requirePermission('attachment:hide'),
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        await service.hideAttachment(request.user!, id, attId, request.log, request.id ?? null);
        return reply.code(204).send();
      },
    );

    // ---------------------------------------------------------------
    // GET /api/projects/:id/attachments/trash — Papierkorb listing.
    // Owner / office only via attachment:trash. Returns the same shape
    // as the live list, with hiddenAt populated.
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id/attachments/trash',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('attachment:trash'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const data = await service.listHiddenForProject(request.user!, id);
        return reply.code(200).send({ data });
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/attachments/:attId/restore — pull the row
    // back from the Papierkorb. Owner / office only via attachment:trash.
    // copyFromVersion runs server-side; the row's persisted version_id
    // pair is the source.
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/attachments/:attId/restore',
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
        preHandler: requirePermission('attachment:trash'),
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        const attachment = await service.restoreAttachment(
          request.user!,
          id,
          attId,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(attachment);
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
