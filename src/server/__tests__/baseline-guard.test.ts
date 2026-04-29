/**
 * Tests for the baseline schema-state recurrence guard. Mirrors the
 * `scripts/deploy.sh` pre-flight check on the dev/boot side; covers
 * the pure-function pieces, the wiring against a real ledger, and a
 * source-pin so the guard cannot silently detach from `start.ts`.
 *
 * The pure-function tests run against a temp `0000_baseline.sql` so
 * they don't depend on the in-tree baseline's sha256. The integration
 * tests call `startApp()` to ensure `migrate()` has populated the
 * ledger, then verify (a) the recorded hash matches the on-disk file,
 * and (b) a mismatch — simulated with a temp folder containing fake
 * content — surfaces with the expected runbook reference.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  assertBaselineLedgerMatchesFile,
  buildMismatchMessage,
  computeBaselineFileHash,
  readRecordedBaselineHash,
} from '../db/baseline-guard.js';
import type { Database } from '../db/connection.js';
import { startApp, stopApp } from '../../test/api-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsFolder = path.resolve(__dirname, '../db/migrations');

describe('computeBaselineFileHash', () => {
  it('returns the sha256 hex of the baseline file content', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'baseline-guard-'));
    try {
      const content = 'hello world';
      writeFileSync(path.join(tmp, '0000_baseline.sql'), content);
      const expected = createHash('sha256').update(content).digest('hex');
      expect(computeBaselineFileHash(tmp)).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('agrees with the digest drizzle-orm uses to populate the ledger', () => {
    // drizzle-orm/migrator.js readMigrationFiles hashes the file's UTF-8
    // string form. Reproduce that computation locally and assert our
    // helper produces the same bytes — the equivalence is the load-bearing
    // contract for the guard's comparison against the recorded hash.
    const baselinePath = path.join(realMigrationsFolder, '0000_baseline.sql');
    const drizzleStyle = createHash('sha256')
      .update(readFileSync(baselinePath).toString())
      .digest('hex');
    expect(computeBaselineFileHash(realMigrationsFolder)).toBe(drizzleStyle);
  });
});

describe('buildMismatchMessage', () => {
  it('includes both hashes and a pointer to the runbook', () => {
    const msg = buildMismatchMessage('deadbeef', 'cafef00d');
    expect(msg).toMatch(/deadbeef/);
    expect(msg).toMatch(/cafef00d/);
    expect(msg).toMatch(/Baseline schema mismatch/);
    expect(msg).toMatch(/recover-from-schema-change\.md/);
  });

  it('does not prescribe a recovery procedure inline', () => {
    // The recovery doc evolves; the inline message should defer to it
    // rather than baking in a procedure that can rot. See the user
    // feedback on commit 7013238 (deploy.sh).
    const msg = buildMismatchMessage('a', 'b');
    expect(msg).not.toMatch(/wipe/i);
    expect(msg).not.toMatch(/reseed/i);
    expect(msg).not.toMatch(/down -v/);
  });
});

describe('readRecordedBaselineHash error-code unwrapping', () => {
  // The pg driver sets `.code` (SQLSTATE) on its errors, but drizzle-orm
  // wraps every pg error in `DrizzleQueryError` and only preserves the
  // original on `.cause` — `.code` does NOT propagate to the wrapper. The
  // integration tests below run against an already-migrated DB so they
  // never hit the catch path; these tests pin the wrapper-unwrapping logic
  // that catches the legitimate fresh-DB cases (`42P01`, `3F000`).
  function makeWrappedDb(code: string, message: string): Database {
    const pgErr: Error & { code?: string } = new Error(message);
    pgErr.code = code;
    const wrapped = new DrizzleQueryError('SELECT hash FROM …', [], pgErr);
    return {
      execute: () => Promise.reject(wrapped),
    } as unknown as Database;
  }

  it('returns null for 42P01 (relation_does_not_exist) wrapped in DrizzleQueryError', async () => {
    const db = makeWrappedDb('42P01', 'relation "drizzle.__drizzle_migrations" does not exist');
    await expect(readRecordedBaselineHash(db)).resolves.toBeNull();
  });

  it('returns null for 3F000 (invalid_schema_name) wrapped in DrizzleQueryError', async () => {
    const db = makeWrappedDb('3F000', 'schema "drizzle" does not exist');
    await expect(readRecordedBaselineHash(db)).resolves.toBeNull();
  });

  it('rethrows pg errors with non-fresh-DB codes', async () => {
    const db = makeWrappedDb('08006', 'connection failure');
    await expect(readRecordedBaselineHash(db)).rejects.toThrow(/Failed query/);
  });
});

describe('readRecordedBaselineHash + assertBaselineLedgerMatchesFile (integration)', () => {
  let db: Database;

  beforeAll(async () => {
    // startApp() runs migrate() which populates the ledger. We don't
    // use the Fastify instance — we just need the side effect on the
    // per-fork test DB.
    await startApp();
    // Get our own connection to the same per-fork DB (DATABASE_URL is
    // already overridden by integration-setup.ts at import time).
    const { createDatabase } = await import('../db/connection.js');
    ({ db } = createDatabase());
  });

  afterAll(async () => {
    await stopApp();
  });

  it('records the same hash as the on-disk baseline file', async () => {
    const recorded = await readRecordedBaselineHash(db);
    expect(recorded).toBe(computeBaselineFileHash(realMigrationsFolder));
  });

  it('passes silently when the ledger matches the on-disk baseline', async () => {
    await expect(
      assertBaselineLedgerMatchesFile(db, realMigrationsFolder),
    ).resolves.toBeUndefined();
  });

  it('throws a mismatch error when the on-disk file differs from the ledger', async () => {
    // Vary the file (cheap, scoped to this test) instead of mutating
    // the ledger (would leak into other test files in the same fork).
    const tmp = mkdtempSync(path.join(tmpdir(), 'baseline-guard-'));
    try {
      writeFileSync(path.join(tmp, '0000_baseline.sql'), 'fake baseline content');
      await expect(assertBaselineLedgerMatchesFile(db, tmp)).rejects.toThrow(
        /Baseline schema mismatch/,
      );
      await expect(assertBaselineLedgerMatchesFile(db, tmp)).rejects.toThrow(
        /recover-from-schema-change\.md/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * Call-site pin — mirrors the technique in env.test.ts (assertProductionSafe).
 * The integration tests above prove the guard works when wired up; this
 * suite asserts the wiring in start.ts is actually in place. A regression
 * that drops the import or moves the call after `migrate()` would leave
 * the unit + integration tests green but defeat the guard's purpose.
 */
describe('start.ts call-site pin for assertBaselineLedgerMatchesFile', () => {
  const startTsPath = path.resolve(__dirname, '../start.ts');
  const startSource = readFileSync(startTsPath, 'utf8');
  // Strip comments so a comment mentioning the symbol does not satisfy
  // the pin. Same simple regex-strip env.test.ts uses.
  const stripped = startSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('imports assertBaselineLedgerMatchesFile from ./db/baseline-guard.js', () => {
    const importPattern =
      /import\s*\{[^}]*\bassertBaselineLedgerMatchesFile\b[^}]*\}\s*from\s*['"]\.\/db\/baseline-guard\.js['"]/s;
    expect(stripped).toMatch(importPattern);
  });

  it('calls assertBaselineLedgerMatchesFile with a non-empty argument', () => {
    const callPattern = /\bassertBaselineLedgerMatchesFile\s*\(\s*\S[^)]*\)/;
    expect(stripped).toMatch(callPattern);
  });

  it('calls the guard before migrate() — running it after would defeat the point', () => {
    // drizzle's migrate() is the call we are guarding; if the guard
    // runs after, the no-op has already happened and the mismatch is
    // masked. Pin the source order.
    const guardIdx = stripped.search(/\bassertBaselineLedgerMatchesFile\s*\(/);
    const migrateIdx = stripped.search(/\bmigrate\s*\(\s*db\b/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(migrateIdx);
  });
});
