/**
 * Boot-time bucket-safety probe. ADR-0022 / docs/ops/object-storage-provisioning.md
 * pin a precise bucket shape — Compliance Object Lock, Versioning, and a
 * single canonical lifecycle rule. This module verifies the running
 * bucket matches that shape and refuses to start on data-corruption-
 * class drift.
 *
 * Shape:
 *   - Versioning: Enabled
 *   - Object Lock: Enabled, default retention COMPLIANCE for R days
 *   - Lifecycle: exactly one Enabled rule, no prefix/tag filter,
 *     NoncurrentVersionExpiration.NoncurrentDays = L,
 *     Expiration.ExpiredObjectDeleteMarker = true,
 *     no other actions (no Expiration.Days — would auto-hide live data;
 *     no Transitions — wrong storage class semantic).
 *
 * Soft drift (`R > L`) reports as a warning — lifecycle reap retries
 * past retention so data still gets destroyed; only the trash-bin TTL
 * stretches.
 *
 * The validator is a pure function over a structured snapshot so the
 * fail/warn matrix is unit-tested without mocking the S3 SDK.
 */

/**
 * B2 portal monikers that the runbook (docs/ops/object-storage-provisioning.md)
 * and ADR-0022 explicitly deny. When B2 round-trips such a rule through
 * the S3 API, the moniker can survive in the rule's ID. Match against the
 * SDK-surfaced ID/Name fields as a defensive belt — the canonical action
 * checks below already reject the resulting `Expiration.Days` shape, but
 * matching the moniker name produces an unambiguous failure message that
 * points the operator at the deny list.
 */
export const LIFECYCLE_DENY_ID_TOKENS: ReadonlyArray<string> = ['daysFromUploadingToHiding'];

export interface BucketSafetyConfig {
  versioningEnabled: boolean;
  objectLock: {
    enabled: boolean;
    defaultMode?: string;
    defaultDays?: number;
  };
  lifecycleRules: ReadonlyArray<LifecycleRuleSnapshot>;
}

/**
 * Structured snapshot of one S3 LifecycleRule, flattened so the validator
 * can assert each field independently. The split between
 * `hasExpirationDays` / `hasExpirationDate` / `hasTransitions` etc. lets
 * the failure message identify the specific defect rather than a generic
 * "disallowed action" — important because the runbook deny list is
 * itemized and operators need to know which item drifted.
 */
export interface LifecycleRuleSnapshot {
  id?: string;
  status: string;
  /** Empty string when no prefix filter — i.e., applies to all objects. */
  prefix: string;
  /** True when the rule has any tag-based filter. */
  hasTagFilter: boolean;
  /** NoncurrentVersionExpiration.NoncurrentDays — the canonical hide-to-delete dial. */
  noncurrentDays?: number;
  /** Expiration.ExpiredObjectDeleteMarker = true — required to reap zombies. */
  expireDeleteMarker: boolean;
  /** Expiration.Days > 0 — auto-hides live data. ADR-0022 deny list. */
  hasExpirationDays: boolean;
  /** Expiration.Date set — same data-loss class as Expiration.Days. */
  hasExpirationDate: boolean;
  /** Any Transitions[] entries — wrong storage-class semantic. */
  hasTransitions: boolean;
  /** Any NoncurrentVersionTransitions[] entries — same. */
  hasNoncurrentTransitions: boolean;
  /** AbortIncompleteMultipartUpload set — outside our hide/reap model. */
  hasAbortMpu: boolean;
}

export type SafetyVerdict =
  | { ok: true; warnings: string[] }
  | { ok: false; failures: string[]; warnings: string[] };

/**
 * Pure validator over the structured snapshot. Returns failures (block
 * boot) and warnings (log only) per ADR-0022's R ≤ L preference.
 */
export function evaluateBucketSafety(config: BucketSafetyConfig): SafetyVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!config.versioningEnabled) {
    failures.push('bucket versioning is not Enabled (required for hide/restore semantics)');
  }

  if (!config.objectLock.enabled) {
    failures.push(
      'Object Lock is not Enabled (Compliance retention is the finite-window backstop)',
    );
  } else {
    if (config.objectLock.defaultMode !== 'COMPLIANCE') {
      failures.push(
        `Object Lock default retention mode is "${config.objectLock.defaultMode ?? 'unset'}", expected COMPLIANCE`,
      );
    }
    if (!config.objectLock.defaultDays || config.objectLock.defaultDays < 1) {
      failures.push(
        `Object Lock default retention days is "${config.objectLock.defaultDays ?? 'unset'}", expected positive integer`,
      );
    }
  }

  if (config.lifecycleRules.length === 0) {
    failures.push(
      'no lifecycle rule configured (hidden versions would never reap — unbounded storage growth)',
    );
  } else if (config.lifecycleRules.length > 1) {
    failures.push(`${config.lifecycleRules.length} lifecycle rules configured, expected exactly 1`);
  } else {
    const rule = config.lifecycleRules[0];
    if (rule.status !== 'Enabled') {
      failures.push(`lifecycle rule status is "${rule.status}", expected Enabled`);
    }
    if (rule.prefix !== '') {
      failures.push(
        `lifecycle rule has prefix filter "${rule.prefix}", expected empty (apply to all objects)`,
      );
    }
    if (rule.hasTagFilter) {
      failures.push('lifecycle rule has a tag filter, expected none (apply to all objects)');
    }
    if (!rule.noncurrentDays || rule.noncurrentDays < 1) {
      failures.push(
        'lifecycle rule has no NoncurrentVersionExpiration.NoncurrentDays (hidden versions would never reap)',
      );
    }
    if (!rule.expireDeleteMarker) {
      failures.push(
        'lifecycle rule lacks ExpiredObjectDeleteMarker=true (delete markers would accumulate as zombies)',
      );
    }

    // Itemized deny list. Each defect emits its own failure so the
    // operator sees exactly which action drifted from the canonical
    // shape — `daysFromHidingToDeleting` is the only allowed lifecycle
    // action per ADR-0022 / docs/ops/object-storage-provisioning.md.
    if (rule.hasExpirationDays) {
      failures.push(
        'lifecycle rule has Expiration.Days > 0 (auto-hides live data — ADR-0022 deny list, equivalent to B2 daysFromUploadingToHiding)',
      );
    }
    if (rule.hasExpirationDate) {
      failures.push(
        'lifecycle rule has Expiration.Date set (auto-hides live data on a calendar date — same data-loss class as Expiration.Days)',
      );
    }
    if (rule.hasTransitions) {
      failures.push(
        'lifecycle rule has Transitions[] (storage-class change is outside the hide/reap model)',
      );
    }
    if (rule.hasNoncurrentTransitions) {
      failures.push(
        'lifecycle rule has NoncurrentVersionTransitions[] (storage-class change is outside the hide/reap model)',
      );
    }
    if (rule.hasAbortMpu) {
      failures.push(
        'lifecycle rule has AbortIncompleteMultipartUpload (outside the canonical reap-only shape)',
      );
    }

    // Mixed semantics: a single rule that both expires current versions
    // AND noncurrent versions is ambiguous. ADR-0022 prescribes exactly
    // one canonical rule, scoped to noncurrent-only.
    if (
      (rule.hasExpirationDays || rule.hasExpirationDate) &&
      rule.noncurrentDays !== undefined &&
      rule.noncurrentDays > 0
    ) {
      failures.push(
        'lifecycle rule mixes Expiration (current) with NoncurrentVersionExpiration — ambiguous semantics, ADR-0022 deny list',
      );
    }

    // Defense-in-depth — match the rule's surfaced ID against the B2
    // portal moniker deny list. The action checks above already reject
    // the structural shape, but a clear "your daysFromUploadingToHiding
    // rule is forbidden" message is more actionable than generic
    // "Expiration.Days > 0".
    if (rule.id) {
      for (const token of LIFECYCLE_DENY_ID_TOKENS) {
        if (rule.id.includes(token)) {
          failures.push(
            `lifecycle rule ID "${rule.id}" matches deny-listed B2 moniker "${token}" — runbook forbids this rule shape`,
          );
        }
      }
    }

    if (
      config.objectLock.defaultDays &&
      rule.noncurrentDays &&
      config.objectLock.defaultDays > rule.noncurrentDays
    ) {
      warnings.push(
        `R (${config.objectLock.defaultDays}d default retention) > L (${rule.noncurrentDays}d hide-to-delete) — trash-bin TTL stretches per ADR-0022; data still reaps eventually`,
      );
    }
  }

  return failures.length === 0 ? { ok: true, warnings } : { ok: false, failures, warnings };
}

export interface SafetyLogger {
  warn: (msg: string) => void;
}

export interface BucketSafetyReader {
  getBucketSafetyConfig: () => Promise<BucketSafetyConfig>;
}

/**
 * Reads the bucket configuration via the storage client and applies the
 * validator. Logs warnings and throws an aggregated error on failure —
 * same fail-fast shape as the existing assertX helpers in
 * src/server/config/env.ts.
 */
export async function assertStorageBucketSafe(
  client: BucketSafetyReader,
  logger: SafetyLogger,
): Promise<void> {
  const config = await client.getBucketSafetyConfig();
  const verdict = evaluateBucketSafety(config);

  for (const w of verdict.warnings) {
    logger.warn(`storage bucket safety: ${w}`);
  }

  if (!verdict.ok) {
    throw new Error(
      `Refusing to start: storage bucket configuration violates ADR-0022.\n${verdict.failures
        .map((f) => `  - ${f}`)
        .join('\n')}\nSee docs/ops/object-storage-provisioning.md.`,
    );
  }
}
