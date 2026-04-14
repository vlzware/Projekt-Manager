/**
 * Project routes — CRUD and transitions for projects.
 * All routes require authentication.
 *
 * Routes are thin HTTP adapters: request parsing, response formatting,
 * Fastify-specific concerns. Business logic lives in ProjectService.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { ProjectService } from '../services/ProjectService.js';

export function projectRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const projectService = new ProjectService(db);

    // Apply auth to all routes in this plugin
    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // GET /api/projects — list with filters
    // ---------------------------------------------------------------
    app.get(
      '/api/projects',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 0, maximum: 200 },
              status: {}, // Accept string or array — Fastify querystring parsing handles both
              search: { type: 'string' },
              hasNoDates: { type: 'string' },
              customerId: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: requirePermission('project:read'),
      },
      async (request, reply) => {
        const query = request.query as {
          offset?: number;
          limit?: number;
          status?: string | string[];
          search?: string;
          hasNoDates?: string;
          customerId?: string;
        };
        const result = await projectService.listProjects({
          offset: query.offset,
          limit: query.limit,
          status: query.status,
          search: query.search,
          hasNoDates: query.hasNoDates === 'true',
          customerId: query.customerId,
        });

        return reply.code(200).send({ data: result.data, total: result.total });
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects — create project
    // ---------------------------------------------------------------
    app.post(
      '/api/projects',
      {
        schema: {
          body: {
            type: 'object',
            required: ['number', 'title', 'customerId'],
            additionalProperties: false,
            properties: {
              number: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
              customerId: { type: 'string', format: 'uuid' },
              status: { type: 'string' },
              plannedStart: { type: ['string', 'null'], format: 'date' },
              plannedEnd: { type: ['string', 'null'], format: 'date' },
              assignedWorkerIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              estimatedValue: { type: ['number', 'null'] },
              notes: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('project:create'),
      },
      async (request, reply) => {
        const body = request.body as {
          number: string;
          title: string;
          customerId: string;
          status?: string;
          plannedStart?: string | null;
          plannedEnd?: string | null;
          assignedWorkerIds?: string[];
          estimatedValue?: number | null;
          notes?: string | null;
        };
        const project = await projectService.createProject(body, request.user!.id, request.log);
        return reply.code(201).send(project);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/projects/:id
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: requirePermission('project:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const project = await projectService.getProject(id);
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/transition/forward
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/transition/forward',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: requirePermission('project:transition'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const project = await projectService.transitionForward(id, request.user!.id, request.log);
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/transition/backward
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/transition/backward',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: requirePermission('project:transition'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const project = await projectService.transitionBackward(id, request.user!.id, request.log);
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // PATCH /api/projects/:id/dates
    // ---------------------------------------------------------------
    app.patch(
      '/api/projects/:id/dates',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              // `null` is allowed so the frontend "clear planned date" flow
              // (ProjectDetailPanel.tsx → updateDates(id, val || null, ...))
              // reaches the repository's falsy→null branch. JSON Schema's
              // `format` keyword applies to strings only; null values bypass
              // it, which is exactly what we want.
              plannedStart: { type: ['string', 'null'], format: 'date' },
              plannedEnd: { type: ['string', 'null'], format: 'date' },
            },
          },
        },
        preHandler: requirePermission('project:dates'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          plannedStart?: string | null;
          plannedEnd?: string | null;
        };

        const project = await projectService.updateDates(id, request.user!.id, body, request.log);
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // PATCH /api/projects/:id — update project fields
    // ---------------------------------------------------------------
    app.patch(
      '/api/projects/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              title: { type: 'string', minLength: 1 },
              customerId: { type: 'string', format: 'uuid' },
              assignedWorkerIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              estimatedValue: { type: ['number', 'null'] },
              notes: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('project:update'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          title?: string;
          customerId?: string;
          assignedWorkerIds?: string[];
          estimatedValue?: number | null;
          notes?: string | null;
        };
        const project = await projectService.updateProject(id, body, request.user!.id, request.log);
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // DELETE /api/projects/:id — soft-delete
    // ---------------------------------------------------------------
    app.delete(
      '/api/projects/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('project:delete'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await projectService.deleteProject(id, request.user!.id, request.log);
        return reply.code(200).send({ success: true, deleted: true });
      },
    );
  };
}
