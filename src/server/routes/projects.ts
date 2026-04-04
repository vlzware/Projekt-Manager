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
import { createAuthMiddleware } from '../middleware/auth.js';

export function projectRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);

    // Apply auth to all routes in this plugin
    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // GET /api/projects
    // ---------------------------------------------------------------
    app.get('/api/projects', async (request, reply) => {
      const query = request.query as { offset?: string; limit?: string };
      const result = await listProjects(db, {
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
      });

      return reply.code(200).send({ data: result.data, total: result.total });
    });

    // ---------------------------------------------------------------
    // GET /api/projects/:id
    // ---------------------------------------------------------------
    app.get('/api/projects/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = await getProject(db, id);

      if (!project) {
        const err = notFound('Projekt');
        return reply.code(err.statusCode).send(err.toResponse());
      }

      return reply.code(200).send(project);
    });

    // ---------------------------------------------------------------
    // POST /api/projects/:id/transition/forward
    // ---------------------------------------------------------------
    app.post('/api/projects/:id/transition/forward', async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const project = await transitionForward(db, id, request.user!.id);
        return reply.code(200).send(project);
      } catch (err) {
        if (err instanceof TransitionError) {
          const appErr = validationError(err.message);
          return reply.code(appErr.statusCode).send(appErr.toResponse());
        }
        throw err;
      }
    });

    // ---------------------------------------------------------------
    // POST /api/projects/:id/transition/backward
    // ---------------------------------------------------------------
    app.post('/api/projects/:id/transition/backward', async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const project = await transitionBackward(db, id, request.user!.id);
        return reply.code(200).send(project);
      } catch (err) {
        if (err instanceof TransitionError) {
          const appErr = validationError(err.message);
          return reply.code(appErr.statusCode).send(appErr.toResponse());
        }
        throw err;
      }
    });

    // ---------------------------------------------------------------
    // PATCH /api/projects/:id/dates
    // ---------------------------------------------------------------
    app.patch('/api/projects/:id/dates', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        plannedStart?: string;
        plannedEnd?: string;
      };

      try {
        const project = await updateDates(db, id, request.user!.id, body);
        return reply.code(200).send(project);
      } catch (err) {
        if (err instanceof DateValidationError) {
          const appErr = validationError(err.message);
          return reply.code(appErr.statusCode).send(appErr.toResponse());
        }
        throw err;
      }
    });
  };
}
