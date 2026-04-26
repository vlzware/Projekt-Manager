/**
 * AC-230 — boot-time feature manifest.
 *
 * Issue #139 traces a silent feature outage to operator forgetfulness:
 * `VAPID_SUBJECT` was missing on prod, so push silently no-op'd until
 * someone noticed manually. The fix has two halves:
 *
 *   1. A single source of truth mapping `feature -> required env var
 *      names` lives in `src/server/config/features.ts` (NEW — does not
 *      yet exist on iteration/9; created by the impl phase). The
 *      registration sites stop using ad-hoc `if (env.X)` checks and
 *      defer to `featureStatus(env, feature)` instead.
 *
 *   2. `start.ts` emits exactly one structured log line at boot
 *      enumerating every feature in the catalog with `enabled` or
 *      `disabled (reason)`. The "what's actually running on this box"
 *      question becomes self-answering, and a missing required var
 *      shows up the moment the container starts — not the first time
 *      a notification would have fired.
 *
 * Coverage pinned by this file:
 *
 *   - `featureStatus(env, feature)` returns `{ enabled: true }` when
 *     every required env var is present.
 *   - When any required var is absent it returns
 *     `{ enabled: false, reason: '<first missing var> is not set' }`.
 *     Ordering is deterministic — the FIRST missing var in the catalog
 *     entry's required list wins, so the manifest line is stable across
 *     boots and operators see one canonical missing-var name.
 *   - The four documented features (`push`, `llm`, `admin-bootstrap`,
 *     `backup`) all behave per the contract.
 *   - `start.ts` calls `emitFeatureManifest(env, logger)` (extracted
 *     into `features.ts` so it is testable without booting Fastify),
 *     and the resulting log line is exactly one `info` call with
 *     `event = 'config-feature-manifest'`, a `features` map keyed by
 *     each feature, and per-feature `{ state, reason? }` where every
 *     non-`enabled` state carries a non-empty `reason`.
 *   - The manifest's reported `state` for a given feature matches what
 *     `featureStatus(env, feature)` returns for the same env — so a
 *     manifest cannot diverge from the wiring it is supposed to mirror.
 *
 * STATUS: Expected to FAIL on iteration/9 — `src/server/config/features.ts`
 * does not yet exist. The impl phase creates it; this test pins the
 * contract before the code lands.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../config/env.js';

// Imports from a module that does not yet exist — the impl phase
// creates `src/server/config/features.ts`. The dynamic-import pattern
// below keeps the file type-checkable today (no missing-module
// compile error) but the test bodies WILL fail when the import resolves
// to undefined.
//
// Why dynamic instead of static: a static `import { featureStatus }
// from '../config/features.js'` would fail at the TypeScript compile
// step BEFORE the test runs, surfacing as a tooling error rather than
// a failing test. The prompt requires the failure to be a behavioural
// one (test runner reports a failed assertion), not a compile error.
async function loadFeaturesModule(): Promise<{
  featureStatus: (env: Env, feature: FeatureName) => FeatureStatus;
  emitFeatureManifest: (env: Env, logger: ManifestLogger) => void;
  FEATURES: readonly FeatureName[];
}> {
  // The module now exists (impl phase landed in #139). The
  // `@ts-expect-error` directive that previously kept the missing-module
  // failure behavioural was removed when the impl module landed —
  // TypeScript would otherwise warn that the expected error is no longer
  // present. The dynamic import shape is kept so the surface this file
  // pins is unambiguously the public API of `../config/features.js`.
  return (await import('../config/features.js')) as unknown as {
    featureStatus: (env: Env, feature: FeatureName) => FeatureStatus;
    emitFeatureManifest: (env: Env, logger: ManifestLogger) => void;
    FEATURES: readonly FeatureName[];
  };
}

type FeatureName = 'push' | 'llm' | 'admin-bootstrap' | 'backup';

type FeatureStatus = { enabled: true } | { enabled: false; reason: string };

interface ManifestLogger {
  info: (ctx: Record<string, unknown>, event?: string) => void;
  /** Optional. The manifest emission must never call these. */
  warn?: (ctx: Record<string, unknown>, event?: string) => void;
  /** Optional. The manifest emission must never call these. */
  error?: (ctx: Record<string, unknown>, event?: string) => void;
}

const MANIFEST_EVENT = 'config-feature-manifest';

/**
 * Build a synthetic `Env` with only the fields needed for the feature
 * status checks. The fixture mirrors `env.test.ts`'s `makeEnv` helper —
 * every `Env` field is present (so the type-checker is satisfied) but
 * the test focuses on the four feature-relevant subsets.
 */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PORT: 3000,
    NODE_ENV: 'test',
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
    R2_ACCESS_KEY_ID: undefined,
    R2_SECRET_ACCESS_KEY: undefined,
    R2_ENDPOINT: undefined,
    R2_BUCKET: undefined,
    R2_REGION: 'auto',
    AGE_RECIPIENT: undefined,
    AGE_IDENTITY_PATH: '/run/drill-key/identity',
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
    ATTACHMENT_PER_FILE_CAP_BYTES: undefined,
    ATTACHMENT_BULK_MAX_FILES: undefined,
    ATTACHMENT_BULK_MAX_BYTES: undefined,
    ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES: undefined,
    ATTACHMENT_WORKER_SELF_DELETE_GRACE_MINUTES: undefined,
    ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES: undefined,
    ...overrides,
  } as Env;
}

// ---------------------------------------------------------------------
// `featureStatus()` per-feature contract.
// ---------------------------------------------------------------------

describe('AC-230: featureStatus(env, "push")', () => {
  it('returns { enabled: true } when both VAPID_PRIVATE_KEY and VAPID_SUBJECT are set', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:ops@example.com',
    });
    expect(featureStatus(env, 'push')).toEqual({ enabled: true });
  });

  it('returns { enabled: false, reason } naming VAPID_PRIVATE_KEY when only that var is missing', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      VAPID_PRIVATE_KEY: undefined,
      VAPID_SUBJECT: 'mailto:ops@example.com',
    });
    const status = featureStatus(env, 'push');
    expect(status).toEqual({
      enabled: false,
      reason: 'VAPID_PRIVATE_KEY is not set',
    });
  });

  it('returns { enabled: false, reason } naming VAPID_SUBJECT when only that var is missing', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: undefined,
    });
    const status = featureStatus(env, 'push');
    expect(status).toEqual({
      enabled: false,
      reason: 'VAPID_SUBJECT is not set',
    });
  });

  it('names the FIRST missing var (VAPID_PRIVATE_KEY) when both are absent — deterministic ordering', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      VAPID_PRIVATE_KEY: undefined,
      VAPID_SUBJECT: undefined,
    });
    const status = featureStatus(env, 'push');
    expect(status).toEqual({
      enabled: false,
      reason: 'VAPID_PRIVATE_KEY is not set',
    });
  });
});

describe('AC-230: featureStatus(env, "llm")', () => {
  it('returns { enabled: true } when OPENROUTER_API_KEY is set', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({ OPENROUTER_API_KEY: 'sk-test' });
    expect(featureStatus(env, 'llm')).toEqual({ enabled: true });
  });

  it('returns { enabled: false, reason } naming OPENROUTER_API_KEY when absent', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({ OPENROUTER_API_KEY: undefined });
    const status = featureStatus(env, 'llm');
    expect(status).toEqual({
      enabled: false,
      reason: 'OPENROUTER_API_KEY is not set',
    });
  });
});

describe('AC-230: featureStatus(env, "admin-bootstrap")', () => {
  it('returns { enabled: true } when both BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD are set', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_PASSWORD: 'changeme',
    });
    expect(featureStatus(env, 'admin-bootstrap')).toEqual({ enabled: true });
  });

  it('returns { enabled: false, reason } naming the first absent bootstrap var', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      BOOTSTRAP_ADMIN_USERNAME: undefined,
      BOOTSTRAP_ADMIN_PASSWORD: undefined,
    });
    const status = featureStatus(env, 'admin-bootstrap');
    // Per the catalog, BOOTSTRAP_ADMIN_USERNAME is listed first.
    expect(status).toEqual({
      enabled: false,
      reason: 'BOOTSTRAP_ADMIN_USERNAME is not set',
    });
  });
});

describe('AC-230: featureStatus(env, "backup")', () => {
  it('returns { enabled: true } when every R2_* var and AGE_RECIPIENT is set', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      R2_ACCESS_KEY_ID: 'ak',
      R2_SECRET_ACCESS_KEY: 'sk',
      R2_ENDPOINT: 'https://r2.example.com',
      R2_BUCKET: 'pm-backups',
      AGE_RECIPIENT: 'age1xyz',
    });
    expect(featureStatus(env, 'backup')).toEqual({ enabled: true });
  });

  it('returns { enabled: false, reason } naming the first absent backup var', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      AGE_RECIPIENT: undefined,
    });
    const status = featureStatus(env, 'backup');
    expect(status).toEqual({
      enabled: false,
      reason: 'R2_ACCESS_KEY_ID is not set',
    });
  });

  it('names the second var as missing when only the first is set', async () => {
    const { featureStatus } = await loadFeaturesModule();
    const env = makeEnv({
      R2_ACCESS_KEY_ID: 'ak',
      R2_SECRET_ACCESS_KEY: undefined,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      AGE_RECIPIENT: undefined,
    });
    const status = featureStatus(env, 'backup');
    expect(status).toEqual({
      enabled: false,
      reason: 'R2_SECRET_ACCESS_KEY is not set',
    });
  });
});

// ---------------------------------------------------------------------
// `emitFeatureManifest()` — the start-time emitter.
// ---------------------------------------------------------------------

describe('AC-230: emitFeatureManifest emits exactly one structured info line', () => {
  it('emits one info call with event = config-feature-manifest, and no warn/error', async () => {
    const { emitFeatureManifest } = await loadFeaturesModule();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const env = makeEnv();

    emitFeatureManifest(env, { info, warn, error });

    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    const [ctx] = info.mock.calls[0]!;
    const c = ctx as Record<string, unknown>;
    expect(c.event).toBe(MANIFEST_EVENT);
  });

  it('the manifest has a `features` map keyed by every feature in the catalog', async () => {
    const { emitFeatureManifest, FEATURES } = await loadFeaturesModule();
    const info = vi.fn();
    const env = makeEnv();

    emitFeatureManifest(env, { info });

    const [ctx] = info.mock.calls[0]!;
    const features = (ctx as Record<string, unknown>).features as Record<string, unknown>;
    expect(features).toBeDefined();
    expect(typeof features).toBe('object');
    for (const f of FEATURES) {
      expect(features).toHaveProperty(f);
    }
  });

  it('each feature value has a `state` of enabled | disabled', async () => {
    const { emitFeatureManifest, FEATURES } = await loadFeaturesModule();
    const info = vi.fn();
    const env = makeEnv();

    emitFeatureManifest(env, { info });

    const [ctx] = info.mock.calls[0]!;
    const features = (ctx as Record<string, unknown>).features as Record<
      string,
      { state: string; reason?: string }
    >;
    for (const f of FEATURES) {
      expect(['enabled', 'disabled']).toContain(features[f]!.state);
    }
  });

  it('every non-enabled state carries a non-empty reason', async () => {
    const { emitFeatureManifest } = await loadFeaturesModule();
    const info = vi.fn();
    // All optional features off → every entry is non-enabled and must
    // carry a reason.
    const env = makeEnv({
      VAPID_PRIVATE_KEY: undefined,
      VAPID_SUBJECT: undefined,
      OPENROUTER_API_KEY: undefined,
      BOOTSTRAP_ADMIN_USERNAME: undefined,
      BOOTSTRAP_ADMIN_PASSWORD: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      AGE_RECIPIENT: undefined,
    });

    emitFeatureManifest(env, { info });

    const [ctx] = info.mock.calls[0]!;
    const features = (ctx as Record<string, unknown>).features as Record<
      string,
      { state: string; reason?: string }
    >;
    for (const [name, value] of Object.entries(features)) {
      if (value.state !== 'enabled') {
        expect(
          (value.reason ?? '').trim().length,
          `feature "${name}" with state="${value.state}" must carry a non-empty reason`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('the manifest state for each feature matches featureStatus(env, feature) for the same env', async () => {
    const { emitFeatureManifest, featureStatus, FEATURES } = await loadFeaturesModule();
    const info = vi.fn();
    // Mixed env so some features are enabled, some are not — exercises
    // both arms of the agreement assertion.
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:ops@example.com',
      OPENROUTER_API_KEY: undefined,
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_PASSWORD: 'changeme',
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      AGE_RECIPIENT: undefined,
    });

    emitFeatureManifest(env, { info });

    const [ctx] = info.mock.calls[0]!;
    const features = (ctx as Record<string, unknown>).features as Record<
      string,
      { state: string; reason?: string }
    >;
    for (const f of FEATURES) {
      const status = featureStatus(env, f);
      const reported = features[f]!;
      if (status.enabled) {
        // featureStatus says enabled → manifest must agree exactly.
        expect(reported.state).toBe('enabled');
      } else {
        // featureStatus says disabled → manifest must report `disabled`
        // (the only non-enabled state per AC-230 / §12.6) with a reason
        // matching featureStatus's reason.
        expect(reported.state).toBe('disabled');
        expect(reported.reason).toBe(status.reason);
      }
    }
  });
});

// ---------------------------------------------------------------------
// Source-string pin — start.ts must call `emitFeatureManifest(env, ...)`.
//
// Same pattern as env.test.ts's call-site pin. start.ts self-invokes on
// import (it migrates, seeds, listens), so a runtime-import test would
// boot the whole server. Reading the file as text is the
// minimum-invasive way to lock the wiring; a regression that drops the
// emission would still pass the unit tests above (the function itself
// is unchanged) but would fail this pin.
// ---------------------------------------------------------------------

describe('AC-230: start.ts wires emitFeatureManifest into the boot path', () => {
  // Source-string pin — same pattern as env.test.ts. start.ts self-
  // invokes on import (it migrates, seeds, listens), so a runtime test
  // would boot the whole server. Reading the file as text and matching
  // against the import + call site is the minimum-invasive way to lock
  // the wiring; a regression that drops the emission would still pass
  // the unit tests above (the function itself is unchanged) but would
  // fail this pin.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const startTs = readFileSync(path.resolve(here, '../start.ts'), 'utf8');
  // Strip block + line comments before matching so a comment mentioning
  // emitFeatureManifest does not satisfy the pin.
  const stripped = startTs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('imports emitFeatureManifest from ./config/features.js', () => {
    const importPattern =
      /import\s*\{[^}]*\bemitFeatureManifest\b[^}]*\}\s*from\s*['"]\.\/config\/features\.js['"]/s;
    expect(stripped).toMatch(importPattern);
  });

  it('calls emitFeatureManifest with at least one argument', () => {
    const callPattern = /\bemitFeatureManifest\s*\(\s*\S[^)]*\)/;
    expect(stripped).toMatch(callPattern);
  });

  it('calls emitFeatureManifest AFTER env validation (so the env is verified before being reported on)', () => {
    // A regression where the manifest emission lands before env
    // validation would log a manifest derived from an unverified env —
    // misleading state on the same event the manifest is meant to
    // surface. Pin the order at the source level. Tolerates either
    // validator entry point — the boot path uses `validateEnvRuntime()`,
    // but a future refactor that points start.ts at a different
    // validator should still satisfy the order pin as long as some
    // `validateEnv*(` call precedes the emit.
    const validateMatch = stripped.search(/\bvalidateEnv\w*\s*\(/);
    const emitMatch = stripped.search(/\bemitFeatureManifest\s*\(/);
    expect(validateMatch, 'validateEnv*() call not found in start.ts').toBeGreaterThanOrEqual(0);
    expect(emitMatch, 'emitFeatureManifest() call not found in start.ts').toBeGreaterThanOrEqual(0);
    expect(emitMatch).toBeGreaterThan(validateMatch);
  });
});
