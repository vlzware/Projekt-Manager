/**
 * Application error types with machine-readable codes
 * and German human-readable messages.
 *
 * Never leaks internal details (stack traces, DB field names, etc.).
 */

import { STRINGS } from '../config/strings.js';

export type ErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'NOT_PERMITTED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR';

export interface AppErrorResponse {
  code: ErrorCode;
  message: string;
  /** Optional machine-readable detail (e.g. ajv validation errors). */
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly userMessage: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(userMessage);
    this.name = 'AppError';
  }

  toResponse(): AppErrorResponse {
    const response: AppErrorResponse = {
      code: this.code,
      message: this.userMessage,
    };
    if (this.details !== undefined) {
      response.details = this.details;
    }
    return response;
  }
}

// ---------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------

export function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', STRINGS.auth.loginFailed, 401);
}

export function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', STRINGS.auth.unauthenticated, 401);
}

export function sessionExpired(): AppError {
  return new AppError('SESSION_EXPIRED', STRINGS.auth.sessionExpired, 401);
}

export function notPermitted(): AppError {
  return new AppError('NOT_PERMITTED', STRINGS.auth.notPermitted, 403);
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError('VALIDATION_ERROR', message, 422, details);
}

export function notFound(entity: string = STRINGS.entities.resource): AppError {
  return new AppError('NOT_FOUND', STRINGS.errors.notFound(entity), 404);
}

export function rateLimited(): AppError {
  return new AppError('RATE_LIMITED', STRINGS.errors.rateLimited, 429);
}

export function serverError(): AppError {
  return new AppError('SERVER_ERROR', STRINGS.errors.serverError, 500);
}
