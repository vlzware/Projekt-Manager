/**
 * Boot-time binary `age` identity probe — fail-closed (AC-239).
 *
 * Pins the operator-loaded-identity boot gate from ADR-0024:
 *   - happy path: a parseable identity at the configured tmpfs path lets
 *     the assertion resolve;
 *   - fail-closed branches: file absent / file unreadable / malformed
 *     identity that fails `age-keygen -y` round-trip → a thrown error
 *     identifying the offending check (translated to a non-zero process
 *     exit at the boot site, parallel to the bucket-safety probe in
 *     `assertStorageBucketSafe`);
 *   - integration arm against the dev tmpfs path / a real `age-keygen`
 *     pair so the path that production runs is exercised, not just the
 *     unit-level branches.
 *
 * Mirrors the structure of `storage-safety.test.ts` (AC-236 / AC-237) —
 * a pure validator (`evaluateBinaryIdentity`) over a snapshot of {file
 * present?, file readable?, parsed recipient?, configured recipient?},
 * plus an orchestrator (`assertBinaryIdentityLoaded`) that reads the
 * file + spawns `age-keygen -y` and aggregates findings into one
 * thrown error matching the same message shape.
 *
 * The implementation does NOT yet exist — these tests fail at import
 * time. Compile errors against the missing module are the right failure
 * mode; the implementation phase lands the module and resolves both.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  evaluateBinaryIdentity,
  assertBinaryIdentityLoaded,
  type BinaryIdentitySnapshot,
} from '../storage/binaryIdentity.js';

// ---------------------------------------------------------------------
// evaluateBinaryIdentity — pure validator over a structured snapshot.
// Pattern mirrors `evaluateBucketSafety` in `storage/safety.ts`.
// ---------------------------------------------------------------------

describe('AC-239: binary-identity boot probe — pure validator', () => {
  const CANONICAL: BinaryIdentitySnapshot = {
    fileExists: true,
    fileReadable: true,
    derivedRecipient: 'age1abcde1234567890abcdef1234567890abcdef1234567890abcde1234abcd',
    configuredRecipient: 'age1abcde1234567890abcdef1234567890abcdef1234567890abcde1234abcd',
  };

  it('passes on the canonical snapshot (file present, readable, recipient match)', () => {
    expect(evaluateBinaryIdentity(CANONICAL)).toEqual({ ok: true });
  });

  it('fails when the identity file is absent', () => {
    const verdict = evaluateBinaryIdentity({ ...CANONICAL, fileExists: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // Error message names the offending check so an operator log
      // line points at the next action (paste the identity).
      expect(verdict.failures.join(' ')).toMatch(/identity.*not.*loaded|identity.*absent/i);
    }
  });

  it('fails when the identity file is present but unreadable', () => {
    // Perms drift on the tmpfs mount — root-only tmpfs containing a file
    // not readable by the running uid. Failure must be distinct from
    // "file absent" so the operator can diagnose perms.
    const verdict = evaluateBinaryIdentity({ ...CANONICAL, fileReadable: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/unreadable|permission/i);
    }
  });

  it('fails when the identity is present but malformed (age-keygen -y rejected it)', () => {
    // The orchestrator captures `derivedRecipient = null` when the
    // round-trip via `age-keygen -y` exits non-zero. The validator
    // must surface that as a failure naming `age-keygen` so the
    // operator knows the paste was corrupt or the wrong format.
    const verdict = evaluateBinaryIdentity({ ...CANONICAL, derivedRecipient: null });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/age-keygen|malformed|round-trip/i);
    }
  });

  it('fails when the derived recipient does not match BINARY_AGE_RECIPIENT (wrong identity loaded)', () => {
    // The most common operator error per `docs/ops/binary-key/load.md`:
    // pasting the backup drill identity into the binary loader (or
    // vice versa). The probe rejects before any wrap takes place.
    const verdict = evaluateBinaryIdentity({
      ...CANONICAL,
      derivedRecipient: 'age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failures.join(' ')).toMatch(/recipient.*mismatch|does not match/i);
    }
  });

  it('aggregates multiple offences into one verdict (no fail-fast)', () => {
    // Same shape as `assertStorageBucketSafe` aggregation: an operator
    // fielding the failure should see every defect at once, not iterate
    // through fix-and-redeploy cycles. Seed two independently-observable
    // arms — `fileReadable: false` (perms drift) AND derived/configured
    // recipient mismatch — so the validator must surface both, not just
    // the first one it hits. (`>= 1` would be tautological with
    // `verdict.ok === false`; `>= 2` is the actual aggregation contract.)
    const verdict = evaluateBinaryIdentity({
      fileExists: true,
      fileReadable: false,
      derivedRecipient: 'age1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configuredRecipient: 'age1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // Two independent defects → at least two failure entries.
      expect(verdict.failures.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------
// assertBinaryIdentityLoaded — IO orchestrator.
// Reads the file, runs `age-keygen -y`, builds the snapshot, calls the
// validator. Throws the aggregated error at the boot site.
// ---------------------------------------------------------------------

describe('AC-239: binary-identity boot probe — orchestration', () => {
  function withTempIdentity<T>(body: (filePath: string) => Promise<T> | T): Promise<T> {
    // Each arm gets its own tmp dir so parallel runs don't trample
    // each other's fixture. `os.tmpdir()` is always writable in the
    // dev container.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'binary-identity-probe-'));
    const filePath = path.join(dir, 'identity');
    return Promise.resolve(body(filePath)).finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; the OS will GC tmp on reboot.
      }
    });
  }

  /**
   * Generate a real age identity via `age-keygen` and return both halves.
   * Used to drive the orchestrator with a known-good fixture.
   */
  function freshAgeIdentity(): { identity: string; recipient: string } {
    const identity = execFileSync('age-keygen', { encoding: 'utf-8' }).trim();
    const recipient = execFileSync('age-keygen', ['-y'], {
      input: identity,
      encoding: 'utf-8',
    }).trim();
    return { identity, recipient };
  }

  it('throws when the identity file does not exist (refusing to start)', async () => {
    await withTempIdentity(async (filePath) => {
      // Path under tmp but never created — the probe must throw.
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
        }),
      ).rejects.toThrow(/Refusing to start/);
    });
  });

  it('throws when the file is present but unreadable by the process', async () => {
    await withTempIdentity(async (filePath) => {
      writeFileSync(filePath, 'AGE-SECRET-KEY-1...\n', { mode: 0o000 });
      try {
        // Mode 0 hides the file from this uid; the probe must fail.
        // (When the test runs as root and `chmod 0` is bypassed, this
        // arm degrades to "file present + age-keygen rejects" — see
        // the next test. The split is the right shape: a perms drift
        // on a non-root operator account is the production-realistic
        // case the probe targets.)
        await expect(
          assertBinaryIdentityLoaded({
            identityPath: filePath,
            configuredRecipient: 'age1xyz',
          }),
        ).rejects.toThrow(/Refusing to start/);
      } finally {
        chmodSync(filePath, 0o600); // restore so the cleanup can rm
      }
    });
  });

  it('throws when the file content fails the `age-keygen -y` round-trip (malformed identity)', async () => {
    await withTempIdentity(async (filePath) => {
      writeFileSync(filePath, 'this-is-not-an-age-identity\n', { mode: 0o400 });
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
        }),
      ).rejects.toThrow(/Refusing to start.*age-keygen|Refusing to start.*malformed/s);
    });
  });

  it('throws when the derived recipient does not match the configured one (wrong identity loaded)', async () => {
    await withTempIdentity(async (filePath) => {
      const { identity } = freshAgeIdentity();
      writeFileSync(filePath, identity + '\n', { mode: 0o400 });
      // Configure with a *different* recipient so the round-trip output
      // mismatches. This is the "operator pasted the backup identity into
      // the binary loader" path documented in load.md / troubleshooting.md.
      const wrongRecipient = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
      await expect(
        assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: wrongRecipient,
        }),
      ).rejects.toThrow(/Refusing to start.*recipient/);
    });
  });

  it('resolves silently on the canonical happy path (file + matching recipient)', async () => {
    await withTempIdentity(async (filePath) => {
      const { identity, recipient } = freshAgeIdentity();
      writeFileSync(filePath, identity + '\n', { mode: 0o400 });
      // No throw — boot proceeds. Mirror `assertStorageBucketSafe`'s
      // healthy-shape arm.
      await assertBinaryIdentityLoaded({
        identityPath: filePath,
        configuredRecipient: recipient,
      });
    });
  });

  it('emits a structured error log line on failure (event identifier present in error)', async () => {
    // The boot site translates the thrown error into a non-zero exit;
    // the structured log line emitted right before the throw is the
    // operator's only diagnostic. Pin its shape — `event` field naming
    // the offending check — by asserting on the thrown error message
    // (the orchestrator's contract is "throw with a message containing
    // the event identifier so the boot site can log+exit with one
    // payload"). Same character as the storage-safety probe's
    // aggregated message.
    await withTempIdentity(async (filePath) => {
      // No file written — the absent-file arm is the simplest trigger.
      try {
        await assertBinaryIdentityLoaded({
          identityPath: filePath,
          configuredRecipient: 'age1xyz',
        });
        throw new Error('expected throw');
      } catch (err) {
        const msg = (err as Error).message;
        // Discriminator: identifies this probe in a log surface that
        // also carries `bucket-safety` and `capability-self-test`
        // failures. A regression that drops the identifier into a
        // generic message would mask which probe failed at boot.
        expect(msg).toMatch(/binary-identity/i);
      }
    });
  });
});
