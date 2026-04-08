/**
 * Tests: First-run admin bootstrap (ADR-0010, issue #57).
 *
 * Covers acceptance criteria AC-B1 through AC-B9 from issue #57.
 *
 * Not covered by this file (verified by code review, not unit tests):
 *
 * - AC-B7 (ordering after migrate / before listen, failure aborts startup):
 *   parts (a) "after migrate()" and (b) "before listen()" are verified by
 *   inspecting src/server/start.ts; part (c) "failure aborts startup" is
 *   verified indirectly by the throw-assertions in AC-B3 and AC-B5 plus
 *   the top-level start().catch() in start.ts that exits non-zero.
 *
 * - AC-B6 unique-constraint fallback: the AC's parenthetical acknowledges
 *   that this is covered by AC-B2 "in practice". The remaining race-window
 *   case (two bootstrap runs interleaving between count and insert) is
 *   mitigated in the implementation by wrapping count+insert in a single
 *   transaction and catching Postgres error code 23505 as a clean error.
 *   This is verified by code review of bootstrap.ts, not by a test, because
 *   the race is not reliably reproducible from vitest.
 *
 * - AC-B10 (docs): documentation, not code.
 *
 * Database isolation: each test TRUNCATEs users, sessions, and projects
 * in beforeEach. Tests use a real Postgres connection (integration project).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import { users } from '../db/schema.js';
import { verifyPassword } from '../password.js';
import { bootstrapAdminIfEmpty } from '../bootstrap.js';
import type { Database } from '../db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

let db: Database;
let pool: pg.Pool;

function makeLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * A syntactically-valid bcrypt hash placeholder for inserting stub rows
 * in idempotency tests. This hash intentionally does NOT match any real
 * password — tests that need verifiable hashes create users via the
 * bootstrap function itself.
 */
const PLACEHOLDER_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8/cN3f.y5h6N5E5hS6LXZ8kA8XwFye';

beforeAll(async () => {
  const conn = createDatabase();
  db = conn.db;
  pool = conn.pool;
  // Verify the pool is live and migrations are in place.
  await pool.query('SELECT 1');
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Bootstrap tests require a truly empty users table. CASCADE handles
  // the FK from sessions and projects.
  await db.execute(sql`TRUNCATE TABLE sessions, projects, users CASCADE`);
});

// -----------------------------------------------------------------------
// AC-B1 — Happy path on empty DB
// -----------------------------------------------------------------------
describe('AC-B1: happy path on empty DB', () => {
  it('inserts exactly one owner-role user when both env vars are set', async () => {
    const result = await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b1', password: 'SecurePass2026!', displayName: 'Admin B1' },
      makeLogger(),
    );

    expect(result.inserted).toBe(true);

    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    const u = rows[0]!;
    expect(u.username).toBe('admin-b1');
    expect(u.displayName).toBe('Admin B1');
    expect(u.roles).toEqual(['owner']);
    expect(u.active).toBe(true);
    expect(u.email).toBeNull();
  });

  it('stores a bcrypt hash that verifies with the original password', async () => {
    await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b1b', password: 'SecurePass2026!', displayName: undefined },
      makeLogger(),
    );
    const [u] = await db.select().from(users);
    expect(u).toBeDefined();
    await expect(verifyPassword('SecurePass2026!', u!.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword('WrongPassword2026', u!.passwordHash)).resolves.toBe(false);
  });

  it('defaults display_name to username when displayName is undefined', async () => {
    await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b1c', password: 'SecurePass2026!', displayName: undefined },
      makeLogger(),
    );
    const [u] = await db.select().from(users);
    expect(u!.displayName).toBe('admin-b1c');
  });

  it('defaults display_name to username when displayName is an empty string', async () => {
    await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b1d', password: 'SecurePass2026!', displayName: '' },
      makeLogger(),
    );
    const [u] = await db.select().from(users);
    expect(u!.displayName).toBe('admin-b1d');
  });
});

// -----------------------------------------------------------------------
// AC-B2 — Idempotent on non-empty DB
// -----------------------------------------------------------------------
describe('AC-B2: idempotent on non-empty DB', () => {
  it('is a no-op when users table has one or more rows, regardless of env vars', async () => {
    await db.insert(users).values({
      username: 'existing-user',
      displayName: 'Existing',
      passwordHash: PLACEHOLDER_HASH,
      roles: ['owner'],
    });

    const logger = makeLogger();
    const result = await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b2', password: 'SecurePass2026!', displayName: undefined },
      logger,
    );

    expect(result.inserted).toBe(false);
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe('existing-user');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips even when env vars violate the password policy', async () => {
    // If the bootstrap short-circuits on a non-empty table, it must not
    // even evaluate the password — otherwise a left-behind weak
    // BOOTSTRAP_ADMIN_PASSWORD would crash the service on every restart.
    await db.insert(users).values({
      username: 'pre-existing',
      displayName: 'Pre',
      passwordHash: PLACEHOLDER_HASH,
      roles: ['owner'],
    });
    const result = await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b2b', password: 'password', displayName: undefined },
      makeLogger(),
    );
    expect(result.inserted).toBe(false);
  });
});

// -----------------------------------------------------------------------
// AC-B3 — Fail closed on half-config
// -----------------------------------------------------------------------
describe('AC-B3: fail closed on half-config', () => {
  it('throws a message naming BOOTSTRAP_ADMIN_PASSWORD as the missing var when only username is set', async () => {
    // Tight regex: the message must actually name the password var as the
    // missing one, not merely mention both var names in some generic error.
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b3', password: '', displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD is required/);
  });

  it('throws the same specific error when password is undefined', async () => {
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b3b', password: undefined, displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD is required/);
  });

  it('throws a message naming BOOTSTRAP_ADMIN_USERNAME as the missing var when only password is set', async () => {
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: '', password: 'SecurePass2026!', displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_USERNAME is required/);
  });

  it('throws the same specific error when username is undefined', async () => {
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: undefined, password: 'SecurePass2026!', displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_USERNAME is required/);
  });

  it('inserts no user when the half-config error is thrown', async () => {
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b3e', password: undefined, displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow();
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// AC-B4 — Truly opt-in when neither var is set
// -----------------------------------------------------------------------
describe('AC-B4: opt-in when neither var is set', () => {
  it('returns inserted:false and does not log when both vars are undefined on empty DB', async () => {
    const logger = makeLogger();
    const result = await bootstrapAdminIfEmpty(
      db,
      { username: undefined, password: undefined, displayName: undefined },
      logger,
    );
    expect(result.inserted).toBe(false);
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns inserted:false when both vars are empty strings on empty DB', async () => {
    const logger = makeLogger();
    const result = await bootstrapAdminIfEmpty(
      db,
      { username: '', password: '', displayName: undefined },
      logger,
    );
    expect(result.inserted).toBe(false);
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// AC-B5 — Password policy applies
// -----------------------------------------------------------------------
describe('AC-B5: password policy applies', () => {
  it('throws a length-violation error when password is shorter than 8 characters', async () => {
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b5', password: 'short1!', displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD.*at least 8/);
  });

  it('throws a blocklist error when password is "password" (blocklist entry)', async () => {
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b5b', password: 'password', displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD.*common-password blocklist/);
  });

  it('throws a blocklist error for a different blocklist entry ("qwerty123")', async () => {
    // Confirms the blocklist is actually consulted, not just hardcoded to
    // reject the single string "password". "qwerty123" is a separate
    // entry in src/server/data/common-passwords.ts.
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b5c', password: 'qwerty123', displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD.*common-password blocklist/);
  });

  it('throws a max-length error when ASCII password exceeds 72 bytes', async () => {
    // 73 ASCII characters = 73 bytes, exceeding bcrypt's 72-byte truncation
    // point. This is the "naive" check — the UTF-8 variant below catches the
    // more subtle case.
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b5d', password: 'a'.repeat(73), displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD.*72/);
  });

  it('throws a max-length error when a UTF-8 password exceeds 72 bytes despite having fewer characters', async () => {
    // Each CJK character is 3 bytes in UTF-8, so 25 × '测' = 75 bytes but
    // only 25 JavaScript characters. If the check uses `.length` instead of
    // `Buffer.byteLength`, this password sneaks through and bcrypt silently
    // truncates. Regression test for the security audit finding on #57.
    const utf8Pw = '测'.repeat(25);
    expect(utf8Pw.length).toBe(25);
    expect(Buffer.byteLength(utf8Pw, 'utf8')).toBe(75);
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b5e', password: utf8Pw, displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD.*72/);
  });

  it('does not insert a user when policy rejects the password', async () => {
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b5f', password: '123456', displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow();
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// AC-B6 — Username edge cases
// -----------------------------------------------------------------------
describe('AC-B6: username edge cases', () => {
  it('accepts a non-ASCII username (German umlaut)', async () => {
    // Walking skeleton has a German-speaking user base — make sure the
    // bootstrap does not silently mangle usernames that contain umlauts.
    await bootstrapAdminIfEmpty(
      db,
      { username: 'müller', password: 'SecurePass2026!', displayName: 'Herr Müller' },
      makeLogger(),
    );
    const [u] = await db.select().from(users);
    expect(u!.username).toBe('müller');
    expect(u!.displayName).toBe('Herr Müller');
  });

  it('treats whitespace-only username as empty (fail closed)', async () => {
    // Whitespace is not a meaningful username. Fail closed like AC-B3.
    await expect(
      bootstrapAdminIfEmpty(
        db,
        { username: '   ', password: 'SecurePass2026!', displayName: undefined },
        makeLogger(),
      ),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_USERNAME is required/);
  });

  it('is a no-op when the requested username already exists (delegates to AC-B2)', async () => {
    // Covers the "in practice" half of AC-B6: if a user already exists with
    // the same username as the bootstrap request, the count() check takes
    // over before the INSERT — the function must not throw a unique-violation
    // error because it must not even reach the INSERT.
    await db.insert(users).values({
      username: 'admin-b6c',
      displayName: 'Pre-existing',
      passwordHash: PLACEHOLDER_HASH,
      roles: ['owner'],
    });
    const logger = makeLogger();
    const result = await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b6c', password: 'SecurePass2026!', displayName: undefined },
      logger,
    );
    expect(result.inserted).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
    // And the pre-existing user's display_name is untouched.
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('Pre-existing');
  });
});

// -----------------------------------------------------------------------
// AC-B8 — Password is never logged or leaked in errors
// -----------------------------------------------------------------------
describe('AC-B8: password never logged', () => {
  it('does not include the plaintext password in any log call on success', async () => {
    const logger = makeLogger();
    const secret = 'CanaryPw-2026-AC-B8-a!';
    await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b8a', password: secret, displayName: undefined },
      logger,
    );
    const allCalls = [...logger.warn.mock.calls, ...logger.error.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        const asString = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(asString).not.toContain(secret);
      }
    }
  });

  it('does not include the plaintext password in a thrown length-violation error', async () => {
    // Use a unique marker to distinguish "contains the password" from
    // "contains the word password". 7 chars → fails AC-B5 length check.
    const shortSecret = 'Xq7m!zQ'; // length 7
    let caught: Error | null = null;
    try {
      await bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b8b', password: shortSecret, displayName: undefined },
        makeLogger(),
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain(shortSecret);
  });

  it('does not include the plaintext password in a thrown too-long error', async () => {
    const longSecret = `Canary-too-long-${'y'.repeat(100)}`;
    let caught: Error | null = null;
    try {
      await bootstrapAdminIfEmpty(
        db,
        { username: 'admin-b8c', password: longSecret, displayName: undefined },
        makeLogger(),
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain(longSecret);
    expect(caught!.message).not.toContain(longSecret.slice(0, 20));
  });

  it('does not include the stored bcrypt hash in any log call', async () => {
    const logger = makeLogger();
    await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b8d', password: 'SecurePass2026!', displayName: undefined },
      logger,
    );
    const [u] = await db.select().from(users);
    const hash = u!.passwordHash;
    for (const call of logger.warn.mock.calls) {
      for (const arg of call) {
        const asString = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(asString).not.toContain(hash);
      }
    }
  });
});

// -----------------------------------------------------------------------
// AC-B9 — Loud warning on success, silent on skip
// -----------------------------------------------------------------------
describe('AC-B9: loud warning on success, silent on skip', () => {
  it('emits exactly one warn-level log with username AND both rotation instructions', async () => {
    const logger = makeLogger();
    await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b9', password: 'SecurePass2026!', displayName: undefined },
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const combined = logger.warn.mock.calls[0]!.map((a) =>
      typeof a === 'string' ? a : JSON.stringify(a),
    ).join(' ');
    // Must name the user that was created so the operator can verify which
    // account to log in as.
    expect(combined).toContain('admin-b9');
    // Must explicitly tell the operator to change the password.
    expect(combined.toLowerCase()).toMatch(/change.*password/);
    // Must explicitly tell the operator to remove the env vars — naming the
    // var prefix rules out vague "rotate your credentials" wording.
    expect(combined).toContain('BOOTSTRAP_ADMIN_');
  });

  it('does not emit the warning when bootstrap is skipped due to empty vars', async () => {
    const logger = makeLogger();
    await bootstrapAdminIfEmpty(
      db,
      { username: undefined, password: undefined, displayName: undefined },
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not emit the warning when bootstrap is skipped due to non-empty DB', async () => {
    await db.insert(users).values({
      username: 'pre-existing',
      displayName: 'Pre',
      passwordHash: PLACEHOLDER_HASH,
      roles: ['owner'],
    });
    const logger = makeLogger();
    await bootstrapAdminIfEmpty(
      db,
      { username: 'admin-b9b', password: 'SecurePass2026!', displayName: undefined },
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
