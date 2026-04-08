/**
 * First-run admin bootstrap.
 *
 * Inserts an initial `owner`-role user when the users table is empty and
 * the `BOOTSTRAP_ADMIN_USERNAME` + `BOOTSTRAP_ADMIN_PASSWORD` environment
 * variables are both set. Opt-in, idempotent, fail-closed on half-config.
 *
 * Called from start.ts after migrate() and before app.listen() — see
 * AC-B7 in issue #57. Any thrown error aborts startup via the existing
 * start().catch(…) handler.
 *
 * See ADR-0010 for the architectural rationale and the "first-deploy
 * ritual" that operators follow: set env vars, deploy, log in, change
 * password, remove env vars, redeploy clean.
 */

import { sql } from 'drizzle-orm';
import type { Database } from './db/connection.js';
import { users } from './db/schema.js';
import { hashPassword } from './password.js';
import { checkPasswordPolicy } from './config/password-policy.js';

export interface BootstrapAdminConfig {
  username: string | undefined;
  password: string | undefined;
  displayName: string | undefined;
}

/**
 * Minimal logger shape for startup code. Intentionally narrower than the
 * service-layer `ServiceLogger` (which is structured pino-style): bootstrap
 * runs before the Fastify app exists (and therefore before `app.log`), so
 * it cannot depend on Fastify's logger and uses plain string messages that
 * map naturally to `console.warn` / `console.error` in start.ts. Keeping
 * the interface narrow also keeps the tests trivially mockable with
 * `vi.fn()` without needing a full pino double.
 */
export interface BootstrapAdminLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface BootstrapAdminResult {
  inserted: boolean;
}

/**
 * Bootstrap the first-run admin user if the users table is empty and
 * the required env vars are present.
 *
 * Order of operations (AC cross-reference in square brackets):
 *
 *   1. Count users → non-empty DB short-circuits BEFORE env-var
 *      validation [AC-B2]. This ensures leftover weak or partial
 *      `BOOTSTRAP_ADMIN_*` values from a previous bootstrap do not
 *      crash the service on restart.
 *
 *   2. Normalize env-var inputs. Undefined, empty, and whitespace-only
 *      are all treated as "not set" [AC-B6].
 *
 *   3. Neither var set → silent no-op [AC-B4]. Dev workflows using
 *      `SEED=true` are not disturbed.
 *
 *   4. Exactly one var set → throw, naming the missing var [AC-B3].
 *
 *   5. Password policy: length (8..72) and common-password blocklist
 *      [AC-B5]. Error messages must not contain the password itself
 *      [AC-B8].
 *
 *   6. Insert inside a transaction with an in-transaction re-check.
 *      This closes the race window between the initial count and the
 *      insert. A Postgres unique-violation (code 23505) at this point
 *      is treated as "another process beat us" — equivalent to a
 *      no-op, not an error [AC-B6 defensive handling].
 *
 *   7. Emit a single warn-level log naming the user and instructing
 *      the operator to rotate the password and remove the env vars
 *      [AC-B9]. The password and hash are never logged [AC-B8].
 */
export async function bootstrapAdminIfEmpty(
  db: Database,
  config: BootstrapAdminConfig,
  logger: BootstrapAdminLogger,
): Promise<BootstrapAdminResult> {
  // ---------------------------------------------------------------
  // Step 1: non-empty DB short-circuit [AC-B2].
  // ---------------------------------------------------------------
  const [countRow] = await db.select({ count: sql<number>`cast(count(*) as int)` }).from(users);
  const initialCount = countRow?.count ?? 0;
  if (initialCount > 0) {
    return { inserted: false };
  }

  // ---------------------------------------------------------------
  // Step 2: normalize inputs [AC-B6].
  // ---------------------------------------------------------------
  const username = config.username?.trim() ?? '';
  const password = config.password ?? '';
  const usernameProvided = username.length > 0;
  const passwordProvided = password.length > 0;

  // ---------------------------------------------------------------
  // Step 3: opt-in check [AC-B4].
  // ---------------------------------------------------------------
  if (!usernameProvided && !passwordProvided) {
    return { inserted: false };
  }

  // ---------------------------------------------------------------
  // Step 4: fail closed on half-config [AC-B3].
  // Messages name the missing var explicitly so operators know what
  // to add to .env.
  // ---------------------------------------------------------------
  if (!passwordProvided) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD is required when BOOTSTRAP_ADMIN_USERNAME is set.');
  }
  if (!usernameProvided) {
    throw new Error('BOOTSTRAP_ADMIN_USERNAME is required when BOOTSTRAP_ADMIN_PASSWORD is set.');
  }

  // ---------------------------------------------------------------
  // Step 5: password policy [AC-B5]. The check itself lives in
  // src/server/config/password-policy.ts so it cannot diverge from the
  // change-password endpoint. Error messages MUST NOT include the
  // password itself [AC-B8] — the violation object does not carry it.
  // ---------------------------------------------------------------
  const violation = checkPasswordPolicy(password);
  if (violation) {
    switch (violation.code) {
      case 'too_short':
        throw new Error(
          `BOOTSTRAP_ADMIN_PASSWORD must be at least ${violation.minLength} characters.`,
        );
      case 'too_long':
        throw new Error(
          `BOOTSTRAP_ADMIN_PASSWORD must not exceed ${violation.maxBytes} bytes when UTF-8 encoded.`,
        );
      case 'blocklist':
        throw new Error(
          'BOOTSTRAP_ADMIN_PASSWORD is in the common-password blocklist. Choose a less common password.',
        );
    }
  }

  // ---------------------------------------------------------------
  // Step 6: hash and insert inside a transaction with re-check.
  // ---------------------------------------------------------------
  const displayName = config.displayName?.trim() || username;
  const passwordHash = await hashPassword(password);

  let didInsert = false;
  try {
    await db.transaction(async (tx) => {
      // Re-check inside the transaction — closes the window between
      // the initial count and the insert.
      const [recount] = await tx.select({ count: sql<number>`cast(count(*) as int)` }).from(users);
      if ((recount?.count ?? 0) > 0) {
        return;
      }
      await tx.insert(users).values({
        username,
        displayName,
        passwordHash,
        roles: ['owner'],
        active: true,
        email: null,
      });
      didInsert = true;
    });
  } catch (err) {
    // Postgres unique_violation: another process inserted a user with
    // the same username between the transactional re-check and the
    // INSERT. This is equivalent to AC-B2 — "another process bootstrapped".
    // Never re-throw with the password or hash attached.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      return { inserted: false };
    }
    throw err;
  }

  if (!didInsert) {
    // The transactional re-check found a pre-existing row; another
    // process beat us. Equivalent to AC-B2.
    return { inserted: false };
  }

  // ---------------------------------------------------------------
  // Step 7: loud warn log [AC-B9]. Password and hash are NOT included.
  // ---------------------------------------------------------------
  logger.warn(
    `Bootstrap admin user "${username}" created. ` +
      'Log in now, change the password, and remove BOOTSTRAP_ADMIN_* ' +
      'from .env before the next deploy (see ADR-0010).',
  );

  return { inserted: true };
}
