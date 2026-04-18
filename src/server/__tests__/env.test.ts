/**
 * Environment safety tests — pure-function tests for the production
 * startup guards, plus a call-site pin on start.ts so the guard cannot
 * be silently detached from the actual startup path. Runs under the
 * integration project (by directory), but does NOT spin up the app or
 * touch the database.
 *
 * These tests lock the ADR-0013 / AC-45 promise that the server refuses
 * to start with ALLOW_INSECURE_HTTP=true in production. The check lives
 * in assertProductionSafe(); a regression that weakens it (removing the
 * throw, inverting the condition, dropping the NODE_ENV dependency) would
 * make one of these tests fail. See consolidation review C-2 and C-4.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { assertAppServerEnv, assertProductionSafe } from '../config/env.js';
import type { Env } from '../config/env.js';

/** Minimal Env shape with only the fields assertProductionSafe reads. */
function makeEnv(overrides: Partial<Env>): Env {
  return {
    PORT: 3000,
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://unused',
    STORAGE_ENDPOINT: 'http://unused',
    STORAGE_BUCKET: 'unused',
    STORAGE_ACCESS_KEY: 'unused',
    STORAGE_SECRET_KEY: 'unused',
    DOMAIN: 'localhost',
    SEED: 'false',
    ALLOW_INSECURE_HTTP: 'false',
    BOOTSTRAP_ADMIN_USERNAME: undefined,
    BOOTSTRAP_ADMIN_PASSWORD: undefined,
    BOOTSTRAP_ADMIN_DISPLAY_NAME: undefined,
    OPENROUTER_API_KEY: undefined,
    OPENROUTER_MODEL: 'google/gemini-2.5-flash-lite',
    SESSION_CLEANUP_INTERVAL_MINUTES: 60,
    // Layer 2 backup env — optional at the app-server level; declared
    // here so the fixture stays in sync with the schema shape.
    R2_ACCESS_KEY_ID: undefined,
    R2_SECRET_ACCESS_KEY: undefined,
    R2_ENDPOINT: undefined,
    R2_BUCKET: undefined,
    R2_REGION: 'auto',
    AGE_RECIPIENT: undefined,
    AGE_IDENTITY_PATH: '/run/drill-key/identity',
    ...overrides,
  };
}

describe('assertProductionSafe', () => {
  it('throws when NODE_ENV=production and ALLOW_INSECURE_HTTP=true', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'production', ALLOW_INSECURE_HTTP: 'true' })),
    ).toThrow(/ALLOW_INSECURE_HTTP=true in production/);
  });

  it('does not throw in production when ALLOW_INSECURE_HTTP=false', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'production', ALLOW_INSECURE_HTTP: 'false' })),
    ).not.toThrow();
  });

  it('does not throw in development even with ALLOW_INSECURE_HTTP=true', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'development', ALLOW_INSECURE_HTTP: 'true' })),
    ).not.toThrow();
  });

  it('does not throw in development with ALLOW_INSECURE_HTTP=false', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'development', ALLOW_INSECURE_HTTP: 'false' })),
    ).not.toThrow();
  });

  // NODE_ENV='test' must behave like development for the guard — vitest
  // itself runs with NODE_ENV defaulting to 'test' on many setups, and the
  // guard's condition is `=== 'production'`, not `!== 'development'`. A
  // future refactor to `!== 'development'` would silently flip test runs
  // into strict mode and break every integration suite. Pin the assumption.
  it('does not throw when NODE_ENV=test and ALLOW_INSECURE_HTTP=true', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'test', ALLOW_INSECURE_HTTP: 'true' })),
    ).not.toThrow();
  });

  it('does not throw when NODE_ENV=test and ALLOW_INSECURE_HTTP=false', () => {
    expect(() =>
      assertProductionSafe(makeEnv({ NODE_ENV: 'test', ALLOW_INSECURE_HTTP: 'false' })),
    ).not.toThrow();
  });
});

/**
 * `assertAppServerEnv` — the app-server-only presence check for the MinIO
 * storage surface. The shared schema keeps STORAGE_* optional so the
 * backup-runner CLI can share validateEnv(); this guard restores the
 * fail-fast semantic where it matters (start.ts) without forcing the
 * backup path to carry values it never reads.
 */
describe('assertAppServerEnv', () => {
  it('throws when STORAGE_ENDPOINT is missing', () => {
    expect(() => assertAppServerEnv(makeEnv({ STORAGE_ENDPOINT: undefined }))).toThrow(
      /STORAGE_ENDPOINT/,
    );
  });

  it('throws when STORAGE_ACCESS_KEY is missing', () => {
    expect(() => assertAppServerEnv(makeEnv({ STORAGE_ACCESS_KEY: undefined }))).toThrow(
      /STORAGE_ACCESS_KEY/,
    );
  });

  it('throws when STORAGE_SECRET_KEY is missing', () => {
    expect(() => assertAppServerEnv(makeEnv({ STORAGE_SECRET_KEY: undefined }))).toThrow(
      /STORAGE_SECRET_KEY/,
    );
  });

  it('lists every missing field in a single error', () => {
    expect(() =>
      assertAppServerEnv(
        makeEnv({
          STORAGE_ENDPOINT: undefined,
          STORAGE_ACCESS_KEY: undefined,
          STORAGE_SECRET_KEY: undefined,
        }),
      ),
    ).toThrow(/STORAGE_ENDPOINT.*STORAGE_ACCESS_KEY.*STORAGE_SECRET_KEY/s);
  });

  it('passes when all three STORAGE_* are set', () => {
    expect(() => assertAppServerEnv(makeEnv({}))).not.toThrow();
  });
});

/**
 * Call-site pin — the pure-function tests above exercise the guard, but
 * they do not exercise the *wiring* in start.ts. A regression that deletes
 * the `assertProductionSafe(env)` line from start.ts would still leave
 * every assertProductionSafe() unit test green, because the function
 * itself is unchanged. This suite reads start.ts as a source file and
 * asserts the import + call site are present, so the refuse-to-start
 * promise from ADR-0013 / AC-45 cannot silently detach from the binary.
 *
 * Option (c) from the consolidation residuals task: a stronger pin would
 * dynamic-import start.ts after stubbing process.env, but start.ts
 * self-invokes on import (it performs DB migrations, seeds, listens).
 * Gating the self-invoke behind an "is-main-module" check would be a
 * behavior change for the production entry point, which the scope of this
 * task forbids. Source-string pinning is the minimum-invasive way to make
 * this regression loud.
 */
describe('start.ts call-site pin for assertProductionSafe', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const startTsPath = path.resolve(__dirname, '../start.ts');
  const startSource = readFileSync(startTsPath, 'utf8');

  /**
   * Strip // line comments and block comments before matching so a
   * comment mentioning assertProductionSafe() does not satisfy the pin.
   * This is a deliberate simple regex-strip, not a full TS parser — the
   * start.ts file is small and does not contain comment-like literals in
   * strings that would confuse it.
   */
  const stripped = startSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('imports assertProductionSafe from ./config/env.js', () => {
    // Match a named import of assertProductionSafe from the env module.
    // Tolerates other named imports on the same line and either quote style.
    const importPattern =
      /import\s*\{[^}]*\bassertProductionSafe\b[^}]*\}\s*from\s*['"]\.\/config\/env\.js['"]/;
    expect(stripped).toMatch(importPattern);
  });

  it('calls assertProductionSafe with a non-empty argument', () => {
    // Match any `assertProductionSafe(...)` call with at least one char
    // of argument content. Flexible on argument form (identifier,
    // function call, expression) but strict that the guard is actually
    // invoked, not merely imported or referenced.
    const callPattern = /\bassertProductionSafe\s*\(\s*\S[^)]*\)/;
    expect(stripped).toMatch(callPattern);
  });

  // Same technique as the guard above: the reaper module owns the sweep
  // logic (unit-tested in session-reaper.test.ts), but the wiring in
  // start.ts is what actually schedules it in the running binary. A
  // regression that drops the call or feeds a literal 60 instead of the
  // validated env value would leave the unit tests green. This pin catches
  // the detachment.
  it('passes env.SESSION_CLEANUP_INTERVAL_MINUTES to startSessionReaper', () => {
    expect(stripped).toMatch(/\bstartSessionReaper\s*\(/);
    expect(stripped).toMatch(/intervalMinutes\s*:\s*env\.SESSION_CLEANUP_INTERVAL_MINUTES\b/);
  });
});
