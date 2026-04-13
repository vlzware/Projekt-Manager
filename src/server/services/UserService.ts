/**
 * User management service — business logic for user CRUD, deactivation,
 * reactivation, and admin password reset.
 */

import type { Database } from '../db/connection.js';
import {
  findById,
  listUsers as listUsersRepo,
  createUser as createUserRepo,
  updateUser as updateUserRepo,
  deleteUser as deleteUserRepo,
  deactivateUser as deactivateUserRepo,
  reactivateUser as reactivateUserRepo,
  changePassword as changePasswordRepo,
  toUserResponse,
} from '../repositories/user.js';
import { deleteSessionsByUserId } from '../repositories/session.js';
import { hashPassword } from '../password.js';
import { checkPasswordPolicy } from '../config/password-policy.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, validationError, conflict, extractSqlState } from '../errors.js';
import type { ServiceLogger } from './Logger.js';

export class UserService {
  constructor(private db: Database) {}

  async listUsers(opts: { offset?: number; limit?: number }) {
    return listUsersRepo(this.db, opts);
  }

  async getUser(id: string) {
    const user = await findById(this.db, id);
    if (!user) throw notFound(STRINGS.entities.user);
    return toUserResponse(user);
  }

  async createUser(
    data: {
      username: string;
      displayName: string;
      password: string;
      roles: string[];
      email?: string | null;
    },
    actorId: string,
    log: ServiceLogger,
  ) {
    // Password policy
    const violation = checkPasswordPolicy(data.password);
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

    const passwordHash = await hashPassword(data.password);

    try {
      const user = await createUserRepo(this.db, {
        username: data.username,
        displayName: data.displayName,
        passwordHash,
        roles: data.roles,
        email: data.email ?? null,
        createdBy: actorId,
        updatedBy: actorId,
      });
      log.info({ userId: user.id, username: data.username }, 'user_created');
      return user;
    } catch (err) {
      if (extractSqlState(err) === '23505') {
        throw conflict(STRINGS.users.duplicateUsername);
      }
      throw err;
    }
  }

  async updateUser(
    id: string,
    data: {
      displayName?: string;
      roles?: string[];
      email?: string | null;
    },
    actorId: string,
    log: ServiceLogger,
  ) {
    const user = await updateUserRepo(this.db, id, actorId, data);
    if (!user) throw notFound(STRINGS.entities.user);
    log.info({ userId: id }, 'user_updated');
    return user;
  }

  async deactivateUser(id: string, actorId: string, log: ServiceLogger) {
    // Prevent self-deactivation
    if (id === actorId) {
      throw validationError(STRINGS.users.cannotDeactivateSelf);
    }

    const user = await deactivateUserRepo(this.db, id, actorId);
    if (!user) throw notFound(STRINGS.entities.user);
    // Invalidate all sessions for the deactivated user
    await deleteSessionsByUserId(this.db, id);

    log.info({ userId: id }, 'user_deactivated');
    return user;
  }

  async reactivateUser(id: string, actorId: string, log: ServiceLogger) {
    const result = await reactivateUserRepo(this.db, id, actorId);
    if (!result) throw notFound(STRINGS.entities.user);
    log.info({ userId: id }, 'user_reactivated');
    return result;
  }

  async deleteUser(id: string, actorId: string, log: ServiceLogger) {
    if (id === actorId) {
      throw validationError(STRINGS.users.cannotDeleteSelf);
    }

    // Invalidate all sessions before deletion (cascade handles it at DB level,
    // but explicit cleanup ensures any in-memory session cache is aware).
    await deleteSessionsByUserId(this.db, id);

    const deleted = await deleteUserRepo(this.db, id);
    if (!deleted) throw notFound(STRINGS.entities.user);

    log.info({ userId: id, actorId }, 'user_deleted');
  }

  async resetPassword(id: string, newPassword: string, actorId: string, log: ServiceLogger) {
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

    const newHash = await hashPassword(newPassword);
    await changePasswordRepo(this.db, id, newHash, actorId);
    // Invalidate all sessions for the target user
    await deleteSessionsByUserId(this.db, id);
    log.info({ userId: id, actorId }, 'password_reset');
  }
}
