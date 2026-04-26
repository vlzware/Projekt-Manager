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
import {
  assertAppServerEnv,
  assertProductionSafe,
  assertStoragePublicEndpointInProduction,
  envSchema,
} from '../config/env.js';
import type { Env } from '../config/env.js';
// Module surface — used by the schema-bypass-cleanup describe blocks at
// the bottom of the file to resolve the (impl-phase) aggregated
// validator regardless of whether it lands as a new export
// (`validateEnvAggregated`) or as an evolution of `validateEnv()`.
import * as envModule from '../config/env.js';

/** Minimal Env shape with only the fields assertProductionSafe reads. */
function makeEnv(overrides: Partial<Env>): Env {
  return {
    PORT: 3000,
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://unused',
    STORAGE_ENDPOINT: 'http://unused',
    STORAGE_PUBLIC_ENDPOINT: undefined,
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
    AUDIT_RETENTION_WINDOW_DAYS: undefined,
    AUDIT_RETENTION_INTERVAL_MINUTES: 1440,
    // Layer 2 backup env — optional at the app-server level. Only the
    // fields the production-safety guards read are declared here; other
    // optionals (LOGIN_RATE_LIMIT_MAX, ATTACHMENT_*) are intentionally
    // omitted to keep the fixture focused on the guards under test.
    R2_ACCESS_KEY_ID: undefined,
    R2_SECRET_ACCESS_KEY: undefined,
    R2_ENDPOINT: undefined,
    R2_BUCKET: undefined,
    R2_REGION: 'auto',
    AGE_RECIPIENT: undefined,
    AGE_IDENTITY_PATH: '/run/drill-key/identity',
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
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
 * `assertStoragePublicEndpointInProduction` — closes the infrastructure
 * footgun where `STORAGE_ENDPOINT=http://storage:9000` (Docker-internal
 * hostname) reaches the browser via presigned URLs the browser cannot
 * resolve, silently breaking every upload until the orphan reaper
 * sweeps it.
 */
describe('assertStoragePublicEndpointInProduction', () => {
  it('throws in production when STORAGE_ENDPOINT is a container-only host and no public override is set', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'http://storage:9000',
          STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ),
    ).toThrow(/STORAGE_PUBLIC_ENDPOINT/);
  });

  it('passes in production when STORAGE_PUBLIC_ENDPOINT is set', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'http://storage:9000',
          STORAGE_PUBLIC_ENDPOINT: 'https://storage.example.com',
        }),
      ),
    ).not.toThrow();
  });

  it('passes in production when STORAGE_ENDPOINT is a public hostname', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'https://storage.example.com',
          STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ),
    ).not.toThrow();
  });

  it('passes in production when STORAGE_ENDPOINT is an IP literal', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'production',
          STORAGE_ENDPOINT: 'http://10.0.0.5:9000',
          STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ),
    ).not.toThrow();
  });

  it('does not throw in development regardless of endpoint shape', () => {
    expect(() =>
      assertStoragePublicEndpointInProduction(
        makeEnv({
          NODE_ENV: 'development',
          STORAGE_ENDPOINT: 'http://storage:9000',
          STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ),
    ).not.toThrow();
  });
});

/**
 * Schema-level regression pin for the `${VAR:-}` compose pattern. Docker
 * Compose substitutes an empty string for an unset variable referenced
 * with `:-`, so the container sees `AUDIT_RETENTION_WINDOW_DAYS=""`.
 * Without the preprocess wrapper, `z.coerce.number()` turns "" into 0
 * and `.positive()` rejects — crashing the app at startup. CI caught
 * this after the smoke-test container started failing to boot; this
 * test freezes the fix.
 */
describe('envSchema AUDIT_RETENTION_WINDOW_DAYS empty-string handling', () => {
  const minimal = { DATABASE_URL: 'postgres://unused' };

  it('coerces "" to undefined so the build-time default applies', () => {
    const parsed = envSchema.parse({ ...minimal, AUDIT_RETENTION_WINDOW_DAYS: '' });
    expect(parsed.AUDIT_RETENTION_WINDOW_DAYS).toBeUndefined();
  });

  it('parses a positive integer string', () => {
    const parsed = envSchema.parse({ ...minimal, AUDIT_RETENTION_WINDOW_DAYS: '30' });
    expect(parsed.AUDIT_RETENTION_WINDOW_DAYS).toBe(30);
  });

  it('still rejects 0 and negatives', () => {
    expect(() => envSchema.parse({ ...minimal, AUDIT_RETENTION_WINDOW_DAYS: '0' })).toThrow();
    expect(() => envSchema.parse({ ...minimal, AUDIT_RETENTION_WINDOW_DAYS: '-5' })).toThrow();
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
    // Source is formatted multi-line by prettier, so `.` alone skips newlines —
    // use the `s` flag so `.` matches across lines inside the braces.
    const importPattern =
      /import\s*\{[^}]*\bassertProductionSafe\b[^}]*\}\s*from\s*['"]\.\/config\/env\.js['"]/s;
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

  it('calls assertStoragePublicEndpointInProduction with a non-empty argument', () => {
    // Parallel pin for the storage-endpoint guard. A regression that
    // drops the call from start.ts would let a misconfigured deploy boot
    // — uploads would silently fail against an unreachable presigned
    // URL (the exact defect this guard exists to prevent).
    const callPattern = /\bassertStoragePublicEndpointInProduction\s*\(\s*\S[^)]*\)/;
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

  it('start.ts wires startAuditRetentionScheduler to the retention env vars', () => {
    expect(stripped).toMatch(/\bstartAuditRetentionScheduler\s*\(/);
    expect(stripped).toMatch(/\benv\.AUDIT_RETENTION_INTERVAL_MINUTES\b/);
    expect(stripped).toMatch(/\benv\.AUDIT_RETENTION_WINDOW_DAYS\b/);
  });
});

// ---------------------------------------------------------------------
// Schema bypass cleanups (issue #139, AC-228 family) — pin the typed-
// schema home of two reads that previously lived as raw `process.env`
// access:
//
//   1. `LOGIN_RATE_LIMIT_MAX` — now a positive-int schema field with no
//      default. `src/server/config/index.ts:getRateLimit()` resolves it
//      via `getEnv()`. Missing values keep the build-time env-aware
//      default in place.
//
//   2. POSTGRES_PASSWORD / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD — the
//      dev-defaults guard moved from `start.ts:rejectDevCredentials()`
//      into `env.ts` (`assertNoDevCredentials`), folded into the
//      aggregated `validateEnv()` error from AC-231 so every entry
//      point (start.ts and backup-runner.ts) shares one guard.
// ---------------------------------------------------------------------

describe('LOGIN_RATE_LIMIT_MAX in schema', () => {
  const minimal = { DATABASE_URL: 'postgres://unused' };

  it('accepts a positive integer string', () => {
    // Arrange — same fixture as the AUDIT_RETENTION_WINDOW_DAYS block;
    // a single required-without-default field plus the candidate.
    // Act — parse with a positive-int override.
    const parsed = envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '15' });
    // Assert — the schema coerces to number and surfaces it on the
    // typed `Env`. Using `as` here because the impl phase decides
    // whether the field is `number | undefined` or has a default.
    expect((parsed as unknown as { LOGIN_RATE_LIMIT_MAX?: number }).LOGIN_RATE_LIMIT_MAX).toBe(15);
  });

  it('rejects zero', () => {
    expect(() => envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '0' })).toThrow();
  });

  it('rejects negative integers', () => {
    expect(() => envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '-5' })).toThrow();
  });

  it('rejects non-numeric strings', () => {
    expect(() => envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: 'lots' })).toThrow();
  });

  it('rejects fractional numbers (must be int)', () => {
    // `z.coerce.number()` alone accepts "3.5"; the schema must apply
    // `.int()` so the rate-limit ceiling is a count, not a rate.
    expect(() => envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '3.5' })).toThrow();
  });

  it('treats absence as undefined so the build-time default applies', () => {
    const parsed = envSchema.parse(minimal);
    expect(
      (parsed as unknown as { LOGIN_RATE_LIMIT_MAX?: number }).LOGIN_RATE_LIMIT_MAX,
    ).toBeUndefined();
  });

  it('coerces "" to undefined (compose `${VAR:-}` pattern)', () => {
    // Same edge case as AUDIT_RETENTION_WINDOW_DAYS — docker compose
    // forwards an unset var as the empty string; the preprocess wrapper
    // must collapse "" to undefined so the build-time default still
    // applies. Without the wrapper, z.coerce.number() turns "" into 0
    // and .positive() rejects, crashing the deploy.
    const parsed = envSchema.parse({ ...minimal, LOGIN_RATE_LIMIT_MAX: '' });
    expect(
      (parsed as unknown as { LOGIN_RATE_LIMIT_MAX?: number }).LOGIN_RATE_LIMIT_MAX,
    ).toBeUndefined();
  });
});

describe('dev-default credentials guard in env.ts', () => {
  /**
   * The aggregated validator. The dev-defaults guard now lives inside
   * `validateEnv()` (the impl exposes it via `assertNoDevCredentials`
   * which `validateEnv` invokes); the test resolves the validator by
   * either an explicit `validateEnvAggregated` name or an input-
   * accepting `validateEnv()` overload.
   */
  function getAggregatedValidator(): (input: Record<string, string | undefined>) => unknown {
    const m = envModule as unknown as Record<string, unknown>;
    if (typeof m.validateEnvAggregated === 'function') {
      return m.validateEnvAggregated as (input: Record<string, string | undefined>) => unknown;
    }
    if (typeof m.validateEnv === 'function') {
      const fn = m.validateEnv as (input?: Record<string, string | undefined>) => unknown;
      if (fn.length >= 1) return fn as (input: Record<string, string | undefined>) => unknown;
    }
    throw new Error(
      'No aggregated validator export found. The impl phase must expose either ' +
        '`validateEnvAggregated(input)` or extend `validateEnv` to accept input.',
    );
  }

  /**
   * Minimal valid prod-shaped env. Each test in this block layers a
   * dev-default credential on top to assert that single fault trips
   * the guard.
   */
  function prodInput(extra: Record<string, string>): Record<string, string | undefined> {
    return {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://prod',
      STORAGE_ENDPOINT: 'https://storage.example.com',
      STORAGE_PUBLIC_ENDPOINT: 'https://storage.example.com',
      STORAGE_ACCESS_KEY: 'ak',
      STORAGE_SECRET_KEY: 'sk',
      STORAGE_BUCKET: 'pm',
      ALLOW_INSECURE_HTTP: 'false',
      ...extra,
    };
  }

  it('throws in production when POSTGRES_PASSWORD is the dev default "postgres"', () => {
    const validate = getAggregatedValidator();
    expect(() => validate(prodInput({ POSTGRES_PASSWORD: 'postgres' }))).toThrow(
      /POSTGRES_PASSWORD/,
    );
  });

  it('throws in production when POSTGRES_PASSWORD is the dev default "devpassword"', () => {
    const validate = getAggregatedValidator();
    expect(() => validate(prodInput({ POSTGRES_PASSWORD: 'devpassword' }))).toThrow(
      /POSTGRES_PASSWORD/,
    );
  });

  it('throws in production when MINIO_ROOT_USER is the dev default "minioadmin"', () => {
    const validate = getAggregatedValidator();
    expect(() => validate(prodInput({ MINIO_ROOT_USER: 'minioadmin' }))).toThrow(/MINIO_ROOT_USER/);
  });

  it('throws in production when MINIO_ROOT_PASSWORD is the dev default "minioadmin"', () => {
    const validate = getAggregatedValidator();
    expect(() => validate(prodInput({ MINIO_ROOT_PASSWORD: 'minioadmin' }))).toThrow(
      /MINIO_ROOT_PASSWORD/,
    );
  });

  it('aggregates the dev-credentials offence with other validation issues', () => {
    // Arrange — a prod input with a dev-default password AND a separate
    // safety-guard offence (ALLOW_INSECURE_HTTP=true). A non-aggregated
    // validator would throw on whichever is checked first; the contract
    // requires both names in the same error.
    const validate = getAggregatedValidator();
    const input = prodInput({
      POSTGRES_PASSWORD: 'postgres',
      ALLOW_INSECURE_HTTP: 'true',
    });

    // Act + Assert.
    let captured: unknown = null;
    try {
      validate(input);
    } catch (err) {
      captured = err;
    }
    expect(
      captured,
      'expected validateEnv to throw on combined dev-default + insecure-HTTP',
    ).toBeTruthy();
    const message = captured instanceof Error ? captured.message : String(captured ?? '');
    expect(message).toContain('POSTGRES_PASSWORD');
    expect(message).toContain('ALLOW_INSECURE_HTTP');
  });

  it('does NOT throw outside production when POSTGRES_PASSWORD is the dev default', () => {
    const validate = getAggregatedValidator();
    const input = prodInput({ POSTGRES_PASSWORD: 'postgres' });
    input.NODE_ENV = 'development';
    expect(() => validate(input)).not.toThrow();
  });

  it('does NOT throw outside production when MINIO_ROOT_USER is the dev default', () => {
    const validate = getAggregatedValidator();
    const input = prodInput({ MINIO_ROOT_USER: 'minioadmin' });
    input.NODE_ENV = 'test';
    expect(() => validate(input)).not.toThrow();
  });
});
