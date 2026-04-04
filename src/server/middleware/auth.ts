/**
 * Authentication middleware — Fastify preHandler hook.
 *
 * Reads Bearer token from Authorization header, validates the session,
 * checks that the user is still active, and attaches user info to the request.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { isSessionExpired } from '@/domain/session.js';
import { findSession } from '../repositories/session.js';
import { unauthenticated, sessionExpired } from '../errors.js';
import type { Database } from '../db/connection.js';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    db?: Database;
  }
}

export function createAuthMiddleware(db: Database) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const err = unauthenticated();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    const token = authHeader.slice(7);

    const result = await findSession(db, token);

    if (!result) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    // Check session expiry
    if (isSessionExpired({ expiresAt: result.session.expiresAt.toISOString() })) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    // Check user is still active
    if (!result.user.active) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    // Attach user to request
    request.user = {
      id: result.user.id,
      username: result.user.username,
      displayName: result.user.displayName,
      roles: result.user.roles,
      email: result.user.email,
    };
  };
}
