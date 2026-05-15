/**
 * VAPID key-material resolution for the Web Push transport (ADR-0023).
 *
 * Single env surface: the operator maintains `VAPID_PRIVATE_KEY` and
 * `VAPID_SUBJECT`. The public half is derived from the private key at
 * startup (P-256 ECDSA, `crypto.createECDH('prime256v1')`) and served
 * to the client via `GET /api/push/vapid-public-key`.
 *
 * Policy:
 *   - `VAPID_PRIVATE_KEY` set → derive public, return material.
 *   - Missing in production → return `null` → `noopPushDispatcher` +
 *     startup warn. Push is disabled; the operator adds the env var.
 *   - Missing in `NODE_ENV=development` → auto-generate a private key,
 *     persist to `data/.vapid/private-key` (gitignored), and return
 *     material. Subsequent boots read the persisted key.
 *   - `NODE_ENV=test` never auto-generates — tests that want push
 *     either set `VAPID_PRIVATE_KEY` or use the no-op fallback.
 *   - Set but malformed → throw. Corrupt config is fail-fast, not
 *     silent degradation.
 */

import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Env } from './env.js';

export interface VapidKeyMaterial {
  privateKey: string;
  publicKey: string;
  subject: string;
}

export interface VapidResolverLogger {
  info?: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface VapidResolverOptions {
  env: Pick<Env, 'NODE_ENV' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>;
  logger?: VapidResolverLogger;
  /** Override for tests. Defaults to `<cwd>/data/.vapid`. */
  dataDir?: string;
}

const DEV_DEFAULT_SUBJECT = 'mailto:admin@localhost';
const KEY_FILE_NAME = 'private-key';
const P256_PRIVATE_KEY_BYTES = 32;

/**
 * Derive the P-256 public key (urlsafe base64) from a VAPID private
 * key. Separate export so tests can pin the derivation surface without
 * going through the full resolver.
 *
 * Node's `ECDH.setPrivateKey` does not validate the scalar — an input
 * of any length is silently accepted and yields a plausible-looking
 * public key. The length check here turns a silently-wrong config
 * into a fail-fast startup error.
 */
export function derivePublicKey(privateKeyBase64Url: string): string {
  const buf = Buffer.from(privateKeyBase64Url, 'base64url');
  if (buf.length !== P256_PRIVATE_KEY_BYTES) {
    throw new Error(
      `expected ${P256_PRIVATE_KEY_BYTES}-byte P-256 scalar, got ${buf.length} bytes`,
    );
  }
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(buf);
  return ecdh.getPublicKey().toString('base64url');
}

function generatePrivateKey(): string {
  return randomBytes(P256_PRIVATE_KEY_BYTES).toString('base64url');
}

function persistDevKey(dir: string, key: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, KEY_FILE_NAME), key, { mode: 0o600 });
}

function loadOrGenerateDevKey(dataDir: string, logger: VapidResolverLogger | undefined): string {
  const keyPath = path.join(dataDir, KEY_FILE_NAME);
  if (existsSync(keyPath)) {
    const persisted = readFileSync(keyPath, 'utf8').trim();
    logger?.info?.(`VAPID: loaded persisted dev private key from ${keyPath}.`);
    return persisted;
  }
  const fresh = generatePrivateKey();
  persistDevKey(dataDir, fresh);
  logger?.info?.(`VAPID: generated dev private key at ${keyPath}.`);
  return fresh;
}

/**
 * Resolve the VAPID material that `WebPushDispatcher` needs. Returns
 * `null` when push should run in no-op mode (missing config in prod /
 * test). Throws on malformed input.
 */
export function resolveVapidKeyMaterial(opts: VapidResolverOptions): VapidKeyMaterial | null {
  const { env, logger } = opts;
  const dataDir = opts.dataDir ?? path.resolve(process.cwd(), 'data', '.vapid');

  let privateKey = env.VAPID_PRIVATE_KEY?.trim() || undefined;
  let subject = env.VAPID_SUBJECT?.trim() || undefined;

  if (!privateKey && env.NODE_ENV === 'development') {
    privateKey = loadOrGenerateDevKey(dataDir, logger);
  }

  if (!privateKey) {
    logger?.warn('VAPID_PRIVATE_KEY missing — Web Push delivery disabled (no-op dispatcher).');
    return null;
  }

  if (!subject && env.NODE_ENV === 'development') {
    subject = DEV_DEFAULT_SUBJECT;
  }
  if (!subject) {
    logger?.warn('VAPID_SUBJECT missing — Web Push delivery disabled (no-op dispatcher).');
    return null;
  }

  let publicKey: string;
  try {
    publicKey = derivePublicKey(privateKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `VAPID_PRIVATE_KEY is malformed (expected urlsafe-base64 32-byte P-256 scalar): ${reason}`,
      { cause: err },
    );
  }

  logger?.info?.(`VAPID: dispatcher active, subject=${subject}.`);
  return { privateKey, publicKey, subject };
}
