/**
 * Project routes — CRUD and transitions for projects.
 * All routes require authentication.
 */

import type { FastifyInstance } from 'fastify';
import {
  listProjects,
  getProject,
  transitionForward,
  transitionBackward,
  updateDates,
  TransitionError,
  DateValidationError,
} from '../repositories/project.js';
import { validationError, notFound } from '../errors.js';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';

export function projectRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);

    // Apply auth to all routes in this plugin
    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // GET /api/projects
    // ---------------------------------------------------------------
    app.get(
      '/api/projects',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 0, maximum: 100 },
            },
          },
        },
      },
      async (request, reply) => {
        const query = request.query as { offset?: number; limit?: number };
        const result = await listProjects(db, {
          offset: query.offset,
          limit: query.limit,
        });

        return reply.code(200).send({ data: result.data, total: result.total });
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
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const project = await getProject(db, id);

        if (!project) throw notFound('Projekt');

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

        try {
          const project = await transitionForward(db, id, request.user!.id);
          return reply.code(200).send(project);
        } catch (err) {
          if (err instanceof TransitionError) throw validationError(err.message);
          throw err;
        }
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

        try {
          const project = await transitionBackward(db, id, request.user!.id);
          return reply.code(200).send(project);
        } catch (err) {
          if (err instanceof TransitionError) throw validationError(err.message);
          throw err;
        }
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
              plannedStart: { type: 'string', format: 'date' },
              plannedEnd: { type: 'string', format: 'date' },
            },
          },
        },
        preHandler: requirePermission('project:dates'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          plannedStart?: string;
          plannedEnd?: string;
        };

        try {
          const project = await updateDates(db, id, request.user!.id, body);
          return reply.code(200).send(project);
        } catch (err) {
          if (err instanceof DateValidationError) throw validationError(err.message);
          throw err;
        }
      },
    );
  };
}
