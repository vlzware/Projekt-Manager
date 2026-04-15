/**
 * Auth service — business logic orchestration for authentication.
 *
 * Sits between routes (HTTP concerns) and repositories (data access).
 * Handles credential verification, session management, and password policy.
 *
 * The service does NOT import from `fastify`. Logging goes through the
 * `ServiceLogger` interface so the service can be invoked from any context
 * (CLI, background job, alternative transport) — see Logger.ts.
 */

import type { Database } from '../db/connection.js';
import type { ThemePreference } from '../../config/themeStorage.js';

import {
  findByUsername,
  updateLastLogin,
  changePassword as changePasswordRepo,
  updateSelf as updateSelfRepo,
} from '../repositories/user.js';
import { createSession, deleteSession, deleteSessionsByUserId } from '../repositories/session.js';
import { hashPassword, verifyPassword } from '../password.js';
import { checkPasswordPolicy } from '../config/password-policy.js';
import { STRINGS } from '../../config/strings.js';
import { invalidCredentials, notFound, validationError } from '../errors.js';
import { AUTH_CONFIG } from '../config/index.js';
import type { ServiceLogger } from './Logger.js';

export class AuthService {
  constructor(private db: Database) {}

  async login(username: string, password: string, ip: string, log: ServiceLogger) {
    const user = await findByUsername(this.db, username);

    // Timing side-channel mitigation: burn the same bcrypt time
    // regardless of whether the user exists.
    if (!user) {
      await verifyPassword(password, AUTH_CONFIG.dummyHash);
      log.info({ username, ip }, 'login_failure');
      throw invalidCredentials();
    }
    if (!user.active) {
      await verifyPassword(password, AUTH_CONFIG.dummyHash);
      log.info({ username, ip }, 'login_failure');
      throw invalidCredentials();
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      log.info({ username, ip }, 'login_failure');
      throw invalidCredentials();
    }

    // Create session
    const expiresAt = new Date(Date.now() + AUTH_CONFIG.sessionDurationMs);
    const session = await createSession(this.db, user.id, expiresAt);

    // Update last login
    await updateLastLogin(this.db, user.id);

    log.info({ username, ip }, 'login_success');

    return {
      token: session.token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        roles: user.roles,
        email: user.email,
        // data-model.md §5.7 / api.md §14.2.1 — login response exposes
        // the user's stored theme preference so the client can render
        // the correct scheme on first paint without an extra round-trip.
        // Narrow the raw text column to the domain literal union; the
        // CHECK constraint in migration 0013 guarantees validity.
        themePreference: user.themePreference as ThemePreference,
      },
    };
  }

  /**
   * Self-scope profile update — used by PATCH /api/auth/me (api.md §14.2.1).
   * Only fields the user themselves controls appear in `patch`; identity-
   * bearing fields stay administrative (see `UserService`).
   */
  async updateSelfPreferences(
    actingUserId: string,
    patch: { themePreference?: ThemePreference },
    log: ServiceLogger,
  ) {
    const updated = await updateSelfRepo(this.db, actingUserId, patch);
    if (!updated) throw notFound(STRINGS.entities.user);
    log.info({ userId: actingUserId }, 'user_self_updated');
    return updated;
  }

  async logout(token: string, userId: string, ip: string, log: ServiceLogger) {
    if (token) {
      await deleteSession(this.db, token);
    }
    log.info({ userId, ip }, 'logout');
  }

  async changePassword(
    userId: string,
    username: string,
    currentPassword: string,
    newPassword: string,
    currentToken: string | undefined,
    ip: string,
    log: ServiceLogger,
  ) {
    const user = await findByUsername(this.db, username);
    if (!user) {
      // Timing side-channel mitigation: burn bcrypt time even when user is missing.
      await verifyPassword(currentPassword, AUTH_CONFIG.dummyHash);
      throw invalidCredentials();
    }

    // Verify current password
    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) throw invalidCredentials();

    // Password policy — length + UTF-8 byte ceiling (bcrypt truncates at
    // 72 bytes, not 72 characters — see ADR-0006 and password-policy.ts).
    // The same checker is called from the bootstrap path, so the two
    // enforcement points cannot diverge.
    const violation = checkPasswordPolicy(newPassword);
    if (violation) {
      switch (violation.code) {
        case 'too_short':
          throw validationError(STRINGS.password.tooShort);
        case 'too_long':
          throw validationError(STRINGS.password.tooLong);
        case 'blocklist':
          throw validationError(STRINGS.password.tooCommon);
      }
    }

    // Hash and store — pass user.id as the actor so updatedBy reflects
    // the self-service password change (data-model.md §5.5 audit
    // metadata contract). A future admin-reset endpoint would pass the
    // admin's id instead.
    // Hash before the transaction (CPU-bound, no DB needed)
    const newHash = await hashPassword(newPassword);

    // Atomic: password change + session invalidation in one transaction.
    // If session cleanup fails, the password change rolls back.
    await this.db.transaction(async (tx) => {
      await changePasswordRepo(tx, user.id, newHash, user.id);
      await deleteSessionsByUserId(tx, user.id, currentToken);
    });

    log.info({ userId, ip }, 'password_change');
  }
}
