/**
 * Auth service — business logic orchestration for authentication.
 *
 * Sits between routes (HTTP concerns) and repositories (data access).
 * Handles credential verification, session management, and password policy.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/connection.js';
import { findByUsername, updateLastLogin, changePassword as changePasswordRepo } from '../repositories/user.js';
import { createSession, deleteSession, deleteSessionsByUserId } from '../repositories/session.js';
import { hashPassword, verifyPassword } from '../password.js';
import { isCommonPassword } from '../data/common-passwords.js';
import { invalidCredentials, validationError } from '../errors.js';
import { AUTH_CONFIG } from '../config/index.js';

export class AuthService {
  constructor(private db: Database) {}

  async login(username: string, password: string, ip: string, log: FastifyBaseLogger) {
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
      },
    };
  }

  async logout(token: string, userId: string, ip: string, log: FastifyBaseLogger) {
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
    log: FastifyBaseLogger,
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

    // Check blocklist
    if (isCommonPassword(newPassword)) {
      throw validationError(
        'Dieses Passwort ist zu häufig. Bitte ein sichereres Passwort wählen.',
      );
    }

    // Hash and store
    const newHash = await hashPassword(newPassword);
    await changePasswordRepo(this.db, user.id, newHash);

    // Invalidate all other sessions (keep the current one alive)
    await deleteSessionsByUserId(this.db, user.id, currentToken);

    log.info({ userId, ip }, 'password_change');
  }
}
