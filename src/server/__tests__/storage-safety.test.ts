/**
 * Boot-time bucket-safety probe — unit tests for the pure validator and
 * one integration test confirming the real MinIO surface satisfies the
 * canonical shape that init-storage.sh produces.
 *
 * The validator is the load-bearing logic; the IO method on the storage
 * client just shapes SDK output into the snapshot shape. Table-driven
 * here — every fail-path documented at the call site doubles as a test
 * row, so a future regression that softens a failure into a warning (or
 * vice versa) trips a specific case.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateBucketSafety,
  assertStorageBucketSafe,
  type BucketSafetyConfig,
  type LifecycleRuleSnapshot,
} from '../storage/safety.js';
import { createStorageClient } from '../storage/client.js';

// ---------------------------------------------------------------------
// Fixtures — start from the canonical shape, mutate per-case.
// ---------------------------------------------------------------------

const CANONICAL_RULE: LifecycleRuleSnapshot = {
  id: 'reap-hidden-versions',
  status: 'Enabled',
  prefix: '',
  hasTagFilter: false,
  noncurrentDays: 2,
  expireDeleteMarker: true,
  hasDisallowedActions: false,
};

const CANONICAL_CONFIG: BucketSafetyConfig = {
  versioningEnabled: true,
  objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 1 },
  lifecycleRules: [CANONICAL_RULE],
};

function withRule(patch: Partial<LifecycleRuleSnapshot>): BucketSafetyConfig {
  return {
    ...CANONICAL_CONFIG,
    lifecycleRules: [{ ...CANONICAL_RULE, ...patch }],
  };
}

// ---------------------------------------------------------------------
// evaluateBucketSafety — pure validator.
// ---------------------------------------------------------------------

describe('evaluateBucketSafety — happy path', () => {
  it('passes the canonical configuration with no warnings', () => {
    const verdict = evaluateBucketSafety(CANONICAL_CONFIG);
    expect(verdict).toEqual({ ok: true, warnings: [] });
  });

  it('passes when R = L', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 2 },
    });
    expect(verdict).toEqual({ ok: true, warnings: [] });
  });
});

describe('evaluateBucketSafety — versioning failures', () => {
  it('fails when versioning is not Enabled', () => {
    const verdict = evaluateBucketSafety({ ...CANONICAL_CONFIG, versioningEnabled: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/versioning is not Enabled/i);
  });
});

describe('evaluateBucketSafety — object-lock failures', () => {
  it('fails when Object Lock is not enabled', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: false },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/Object Lock is not Enabled/i);
  });

  it('fails when default retention mode is GOVERNANCE (bypassable)', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: true, defaultMode: 'GOVERNANCE', defaultDays: 1 },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/expected COMPLIANCE/);
  });

  it('fails when default retention days is unset or zero', () => {
    for (const days of [undefined, 0]) {
      const verdict = evaluateBucketSafety({
        ...CANONICAL_CONFIG,
        objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: days },
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/positive integer/);
    }
  });
});

describe('evaluateBucketSafety — lifecycle failures', () => {
  it('fails when no lifecycle rule is configured', () => {
    const verdict = evaluateBucketSafety({ ...CANONICAL_CONFIG, lifecycleRules: [] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/no lifecycle rule/);
  });

  it('fails when more than one lifecycle rule is configured', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      lifecycleRules: [CANONICAL_RULE, { ...CANONICAL_RULE, id: 'extra' }],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/2 lifecycle rules/);
  });

  it('fails when the rule is Disabled', () => {
    const verdict = evaluateBucketSafety(withRule({ status: 'Disabled' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/expected Enabled/);
  });

  it('fails when the rule has a prefix filter', () => {
    const verdict = evaluateBucketSafety(withRule({ prefix: 'photos/' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/prefix filter/);
  });

  it('fails when the rule has a tag filter', () => {
    const verdict = evaluateBucketSafety(withRule({ hasTagFilter: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/tag filter/);
  });

  it('fails when NoncurrentDays is missing or zero', () => {
    for (const noncurrent of [undefined, 0]) {
      const verdict = evaluateBucketSafety(withRule({ noncurrentDays: noncurrent }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/NoncurrentVersionExpiration/);
    }
  });

  it('fails when ExpiredObjectDeleteMarker is false', () => {
    const verdict = evaluateBucketSafety(withRule({ expireDeleteMarker: false }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/ExpiredObjectDeleteMarker/);
  });

  it('fails when the rule has any disallowed action (Expiration.Days, Transitions, …)', () => {
    const verdict = evaluateBucketSafety(withRule({ hasDisallowedActions: true }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failures.join(' ')).toMatch(/actions beyond/);
  });
});

describe('evaluateBucketSafety — R > L is a warning, not a failure', () => {
  it('warns but passes when R > L (lifecycle reap retries past retention)', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 7 },
      lifecycleRules: [{ ...CANONICAL_RULE, noncurrentDays: 2 }],
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.warnings.join(' ')).toMatch(/R \(7d.*\) > L \(2d/);
  });

  it('does NOT warn when R = L', () => {
    const verdict = evaluateBucketSafety({
      ...CANONICAL_CONFIG,
      objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 2 },
      lifecycleRules: [{ ...CANONICAL_RULE, noncurrentDays: 2 }],
    });
    expect(verdict).toEqual({ ok: true, warnings: [] });
  });
});

describe('evaluateBucketSafety — multiple offences aggregate', () => {
  it('reports every failure in one verdict (no fail-fast on first offence)', () => {
    const verdict = evaluateBucketSafety({
      versioningEnabled: false,
      objectLock: { enabled: false },
      lifecycleRules: [],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.length).toBeGreaterThanOrEqual(3);
      expect(verdict.failures.join(' ')).toMatch(/versioning/);
      expect(verdict.failures.join(' ')).toMatch(/Object Lock/);
      expect(verdict.failures.join(' ')).toMatch(/no lifecycle rule/);
    }
  });
});

// ---------------------------------------------------------------------
// assertStorageBucketSafe — orchestration. Stub the reader, capture
// warnings, expect throw on failure.
// ---------------------------------------------------------------------

describe('assertStorageBucketSafe — orchestration', () => {
  function makeReader(config: BucketSafetyConfig) {
    return { getBucketSafetyConfig: () => Promise.resolve(config) };
  }

  it('logs warnings via the supplied logger and resolves on a passing config', async () => {
    const warns: string[] = [];
    await assertStorageBucketSafe(
      makeReader({
        ...CANONICAL_CONFIG,
        objectLock: { enabled: true, defaultMode: 'COMPLIANCE', defaultDays: 7 },
      }),
      { warn: (m) => warns.push(m) },
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/storage bucket safety: R \(7d.*\) > L/);
  });

  it('throws an aggregated error on a failing config, listing every offence', async () => {
    const warns: string[] = [];
    await expect(
      assertStorageBucketSafe(
        makeReader({
          versioningEnabled: false,
          objectLock: { enabled: false },
          lifecycleRules: [],
        }),
        { warn: (m) => warns.push(m) },
      ),
    ).rejects.toThrow(/Refusing to start.*versioning.*Object Lock.*lifecycle/s);
    expect(warns).toHaveLength(0); // no R/L pair to compare → no warning
  });
});

// ---------------------------------------------------------------------
// Integration — real MinIO surface, against the canonical bucket
// init-storage.sh produces. Confirms the IO path matches the validator's
// expected shape.
// ---------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} must be set. STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, ` +
        'STORAGE_SECRET_KEY are required. Silent skipping is not allowed.',
    );
  }
  return v;
}

describe('assertStorageBucketSafe — integration with the dev MinIO bucket', () => {
  it('passes the canonical bucket the init script produces (no failures, no warnings)', async () => {
    const client = createStorageClient({
      endpoint: requireEnv('STORAGE_ENDPOINT'),
      bucket: requireEnv('STORAGE_BUCKET'),
      accessKey: requireEnv('STORAGE_ACCESS_KEY'),
      secretKey: requireEnv('STORAGE_SECRET_KEY'),
    });
    const warns: string[] = [];
    // Throws on failure — implicit assertion. Defaults from init-storage.sh
    // are R=1, L=2, so R ≤ L holds and no warning fires.
    await assertStorageBucketSafe(client, { warn: (m) => warns.push(m) });
    expect(warns).toEqual([]);
  });
});
