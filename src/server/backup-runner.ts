/**
 * Layer 2 backup CLI entry point.
 *
 * Contract (scripts/backup/run-backup.sh, run-drill.sh):
 *   node /app/dist/server/backup-runner.js <run|drill|--help>
 *
 * This file is deliberately thin. It wires up env → DB connection →
 * real subprocess helpers (pg_dump, age, ephemeral postgres, R2) and
 * delegates the actual pipeline to `services/backup.ts::runBackup` for
 * `run` and `services/backup-drill.ts::runDrill` for `drill`.
 *
 * Exit codes:
 *   0   run/drill ok; drill skipped (per AC-168 skip != failure)
 *   1   run/drill failed; env missing; unknown internal error
 *   2   usage error (unknown subcommand)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateEnvRuntime, type Env } from './config/env.js';
import { createDatabase, type Database } from './db/connection.js';
import {
  runBackup,
  pgDumpSource,
  ageEncrypt,
  sanitizeErrorMessage,
  type Encryptor,
} from './services/backup.js';
import { runDrill } from './services/backup-drill.js';
import { ephemeralPgVerify } from './services/ephemeralPg.js';
import { createR2Uploader, createR2Downloader, type R2Config } from './services/r2Uploader.js';

const USAGE =
  'usage: backup-runner <run|drill|--help>\n' +
  '  run    — execute one Layer 2 backup cycle (pg_dump + Tier 1 verify + encrypt + upload)\n' +
  '  drill  — execute one Tier 2 drill (download + decrypt + verify against manifest)\n';

async function main(): Promise<number> {
  const subcommand = process.argv[2];

  if (subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  // Fail early on an unknown subcommand — a typo in the cron line
  // should be obvious, not silently tracked as "success".
  if (subcommand !== 'run' && subcommand !== 'drill') {
    process.stderr.write(USAGE);
    return 2;
  }

  // Env validation — reuses the app's schema. The backup-specific keys
  // are declared there with the right defaults (AGE_IDENTITY_PATH etc.).
  const env = validateEnvRuntime();

  if (subcommand === 'run') {
    return runSubcommand(env);
  }
  return drillSubcommand(env);
}

// ---------------------------------------------------------------
// `run` — full Layer 2 cycle
// ---------------------------------------------------------------

async function runSubcommand(env: Env): Promise<number> {
  const r2 = requireR2(env, 'run');
  const recipient = requireEnv(env.AGE_RECIPIENT, 'AGE_RECIPIENT', 'run');

  const { db, pool } = createDatabase();
  try {
    const uploader = createR2Uploader(r2);
    const dumpSource = pgDumpSource(env.DATABASE_URL);
    const verifyManifest = ephemeralPgVerify();
    const encrypt: Encryptor = ageEncrypt(recipient);

    const result = await runBackup({
      db,
      uploader,
      dumpSource,
      verifyManifest,
      encrypt,
      now: new Date(),
    });

    if (result.ok) {
      // Concise one-liner on stdout; keeps log streams readable without
      // dumping the entire manifest (could be noisy on many tables).
      process.stdout.write(
        `backup-runner: run ok dump=${result.uploadedKeys.dump} manifest=${result.uploadedKeys.manifest}\n`,
      );
      return 0;
    }
    // Failed run — write a structured error cue. Never leak secrets
    // (DATABASE_URL, AGE_RECIPIENT), only the service-emitted reason.
    process.stderr.write(
      `backup-runner: run failed reason=${JSON.stringify(result.error)}` +
        (result.failedTable ? ` failedTable=${result.failedTable}` : '') +
        '\n',
    );
    return 1;
  } catch (err) {
    process.stderr.write(`backup-runner: run unexpected error: ${errorMessage(err)}\n`);
    return 1;
  } finally {
    await shutdown(db, pool);
  }
}

// ---------------------------------------------------------------
// `drill` — Tier 2 verify-on-cycle
// ---------------------------------------------------------------

async function drillSubcommand(env: Env): Promise<number> {
  const r2 = requireR2(env, 'drill');

  const { db, pool } = createDatabase();
  try {
    const downloader = createR2Downloader(r2);
    const verifyManifest = ephemeralPgVerify();
    const identityPath = env.AGE_IDENTITY_PATH;

    // M5 audit finding: guard against an operator typo that would
    // point AGE_IDENTITY_PATH at a sensitive system file (/etc/shadow)
    // or escape via `..` into the host FS. `path.resolve` normalises
    // and must remain under the tmpfs mount. Refuse loudly rather than
    // pass a wild path through to `age -d -i`.
    assertIdentityPathUnderTmpfs(identityPath);

    // The drill service needs `expectedManifest` up front, but we don't
    // want to pay for a download when the key is absent (AC-168 — the
    // downloader "must not be called when key is absent"). We check
    // the identity file ourselves here and short-circuit to the skip
    // branch of `runDrill` without populating anything network-bound.
    const identityPresent = await isIdentityPresentAndNonEmpty(identityPath);

    // Downloaded cipher pair (populated only on the non-skip path).
    let dumpCipher: Uint8Array | null = null;
    let manifestPlain: Uint8Array | null = null;

    if (identityPresent) {
      const downloaded = await downloader.downloadLatestDumpAndManifest();
      dumpCipher = downloaded.dump;
      // The sidecar manifest is encrypted too (AC-167). Decrypt it here
      // so we can hand the plaintext into `runDrill` as `expectedManifest`.
      manifestPlain = await ageDecrypt(downloaded.manifest, identityPath);
    }

    const expectedManifest =
      manifestPlain !== null
        ? (JSON.parse(Buffer.from(manifestPlain).toString('utf-8')) as Record<
            string,
            { rowCount: number; checksum: string }
          >)
        : undefined;

    const result = await runDrill({
      db,
      identityPath,
      downloadLatestDump: async () => {
        // If identity was absent, runDrill's own skip check fires
        // before this is invoked — the throw here is a belt-and-suspenders
        // guard that mirrors the test-harness expectations (the test
        // has the downloader throw when the key is absent and asserts
        // that runDrill's skip branch fires without calling it).
        if (dumpCipher === null) {
          throw new Error('dump not downloaded — drill key was absent');
        }
        return dumpCipher;
      },
      decrypt: async (ciphertext, path) => ageDecrypt(ciphertext, path),
      verifyManifest,
      expectedManifest,
      now: new Date(),
    });

    if (result.outcome === 'ok') {
      process.stdout.write('backup-runner: drill ok\n');
      return 0;
    }
    if (result.outcome === 'skipped') {
      // AC-168 — a skip is not a failure. Log distinctly so operators
      // see the cue in the cron log tail.
      process.stdout.write(`backup-runner: drill skipped reason=${result.reason ?? 'unknown'}\n`);
      return 0;
    }
    process.stderr.write(
      `backup-runner: drill failed reason=${result.reason ?? 'unknown'}` +
        (result.mismatchedTable ? ` mismatchedTable=${result.mismatchedTable}` : '') +
        '\n',
    );
    return 1;
  } catch (err) {
    // `age -d` today does not echo the identity path, but a future
    // age release might. Scrub credential-shaped strings (via
    // sanitizeErrorMessage) AND any literal substring matching the
    // tmpfs identity prefix before logging. Defense in depth.
    const raw = errorMessage(err);
    const scrubbed = sanitizeErrorMessage(raw).replace(
      /\/run\/drill-key\/[^\s"'`]*/g,
      '<redacted-identity-path>',
    );
    process.stderr.write(`backup-runner: drill unexpected error: ${scrubbed}\n`);
    return 1;
  } finally {
    await shutdown(db, pool);
  }
}

// ---------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------

function requireR2(env: Env, subcommand: string): R2Config {
  return {
    endpoint: requireEnv(env.R2_ENDPOINT, 'R2_ENDPOINT', subcommand),
    bucket: requireEnv(env.R2_BUCKET, 'R2_BUCKET', subcommand),
    accessKeyId: requireEnv(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID', subcommand),
    secretAccessKey: requireEnv(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY', subcommand),
    region: env.R2_REGION,
  };
}

function requireEnv(value: string | undefined, name: string, subcommand: string): string {
  if (!value) {
    throw new Error(`backup-runner ${subcommand}: ${name} is required but not set`);
  }
  return value;
}

/** Prefix that AGE_IDENTITY_PATH must resolve under (M5 audit). */
const DRILL_TMPFS_PREFIX = '/run/drill-key/';

/**
 * Refuse to continue if `identityPath` does not resolve under the
 * tmpfs prefix. Closes the M5 audit finding: an operator typo like
 * `AGE_IDENTITY_PATH=/etc/shadow` or `AGE_IDENTITY_PATH=../../tmp/x`
 * would otherwise pass straight through to `age -d -i <path>` and the
 * failure message could disclose whatever file age tried to parse.
 *
 * Throws synchronously — caller is the drill-subcommand body, wrapped
 * in the outer try/catch that sanitises before logging.
 */
function assertIdentityPathUnderTmpfs(identityPath: string): void {
  const resolved = path.resolve(identityPath);
  // Accept the mount root itself (unusual but permitted) or any path
  // that begins with the prefix AFTER normalisation. `startsWith` on
  // the already-resolved path is safe against `..` because `resolve`
  // has already collapsed them.
  const underPrefix =
    resolved === DRILL_TMPFS_PREFIX.slice(0, -1) || resolved.startsWith(DRILL_TMPFS_PREFIX);
  if (!underPrefix) {
    throw new Error(
      `AGE_IDENTITY_PATH must resolve under ${DRILL_TMPFS_PREFIX} ` +
        `(got ${JSON.stringify(resolved)})`,
    );
  }
}

/**
 * Inspect the tmpfs identity path. Mirrors the classification inside
 * `services/backup-drill.ts::inspectIdentity` — present and non-empty
 * → drill proceeds; any other state → skip.
 */
async function isIdentityPresentAndNonEmpty(identityPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(identityPath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// age decrypt (spawns `age -d -i <identityPath>` on stdin)
// ---------------------------------------------------------------

function ageDecrypt(ciphertext: Uint8Array, identityPath: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn('age', ['-d', '-i', identityPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Uint8Array[] = [];
    const stderr: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(new Uint8Array(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf-8'));
    });
    child.once('error', (err) => reject(new Error(`age -d failed to spawn: ${err.message}`)));
    child.once('close', (code) => {
      if (code !== 0) {
        // Never include identityPath in the error message — it's the
        // tmpfs path, and echoing it to logs is an unnecessary detail
        // for an operator tailing a broken drill.
        reject(new Error(`age -d exited ${code}: ${stderr.join('').trim()}`));
        return;
      }
      const total = stdout.reduce((acc, c) => acc + c.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of stdout) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(out);
    });
    child.stdin.end(ciphertext);
  });
}

// ---------------------------------------------------------------
// Common
// ---------------------------------------------------------------

async function shutdown(_db: Database, pool: { end(): Promise<void> }): Promise<void> {
  try {
    await pool.end();
  } catch {
    // Best-effort cleanup. If we got here the runner is already exiting.
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown';
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`backup-runner: fatal: ${errorMessage(err)}\n`);
    process.exit(1);
  });
