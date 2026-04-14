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
  | 'CONFLICT'
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

export function conflict(message: string): AppError {
  return new AppError('CONFLICT', message, 409);
}

/**
 * Walk a (possibly wrapped) Error chain looking for a 5-char SQLSTATE code.
 * Returns null when no code is found.
 */
export function extractSqlState(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (!(current instanceof Error)) break;
    const withCode = current as Error & { code?: string };
    if (typeof withCode.code === 'string' && /^[0-9A-Z]{5}$/.test(withCode.code)) {
      return withCode.code;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
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
