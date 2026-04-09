/**
 * Application error types with machine-readable codes
 * and German human-readable messages.
 *
 * Never leaks internal details (stack traces, DB field names, etc.).
 */

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
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly userMessage: string,
    public readonly statusCode: number,
  ) {
    super(userMessage);
    this.name = 'AppError';
  }

  toResponse(): AppErrorResponse {
    return {
      code: this.code,
      message: this.userMessage,
    };
  }
}

// ---------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------

export function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 'Anmeldung fehlgeschlagen.', 401);
}

export function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 'Nicht angemeldet.', 401);
}

export function sessionExpired(): AppError {
  return new AppError('SESSION_EXPIRED', 'Sitzung abgelaufen.', 401);
}

export function notPermitted(): AppError {
  return new AppError('NOT_PERMITTED', 'Keine Berechtigung.', 403);
}

export function validationError(message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, 422);
}

export function notFound(entity = 'Ressource'): AppError {
  return new AppError('NOT_FOUND', `${entity} nicht gefunden.`, 404);
}

export function rateLimited(): AppError {
  return new AppError('RATE_LIMITED', 'Zu viele Anfragen. Bitte später erneut versuchen.', 429);
}

export function serverError(): AppError {
  return new AppError('SERVER_ERROR', 'Ein interner Fehler ist aufgetreten.', 500);
}
