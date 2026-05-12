/**
 * Server-side AES-256-GCM envelope for rendered invoice PDF bytes.
 *
 * Mirrors `src/domain/clientEncryption.ts` exactly on the wire shape
 * (`nonce(12) || ct || tag(16)`) so a future operator-side tool can
 * decrypt either an attachment ciphertext or an invoice ciphertext
 * with the same primitives. The browser uses WebCrypto; the server
 * uses Node `node:crypto` — both produce byte-identical AES-256-GCM
 * envelopes.
 *
 * Why duplicate the helper instead of re-using
 * `clientEncryption.encryptBlob`: the client helper depends on
 * `globalThis.crypto.subtle`, which is present on Node ≥ 19 but lives
 * behind an async API that returns Promises. The server path runs
 * inside a DB transaction (`mutate()`'s `run` callback) so a sync
 * `createCipheriv` keeps the call ergonomic and side-steps the extra
 * microtask hop. The output is byte-equivalent.
 *
 * DEK provenance: `node:crypto.randomBytes` is the W3C-mandated CSPRNG
 * surface on Node — the OS entropy pool feed, same source as
 * `crypto.getRandomValues` in browsers. One DEK per render, single-use
 * (ADR-0024 §DEK provenance).
 */

import crypto from 'node:crypto';

const NONCE_BYTES = 12;
const DEK_BYTES = 32;
const TAG_BYTES = 16;

export interface EncryptedInvoicePayload {
  ciphertext: Uint8Array;
  dek: Uint8Array;
}

/**
 * Encrypt `plaintext` under a freshly-generated 32-byte DEK with
 * AES-256-GCM. Returns the wire-format ciphertext (`nonce || ct ||
 * tag`) AND the DEK — the caller is responsible for wrapping the DEK
 * before persistence (the unwrapped DEK MUST NOT touch the DB).
 */
export function encryptInvoicePayload(plaintext: Uint8Array): EncryptedInvoicePayload {
  const dek = crypto.randomBytes(DEK_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
  const ctBody = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const out = new Uint8Array(NONCE_BYTES + ctBody.byteLength + TAG_BYTES);
  out.set(nonce, 0);
  out.set(ctBody, NONCE_BYTES);
  out.set(authTag, NONCE_BYTES + ctBody.byteLength);
  return { ciphertext: out, dek: new Uint8Array(dek) };
}

/**
 * Decrypt an invoice payload `nonce || ct || tag` under `dek`. Used
 * by the future PDF download route — Phase C does not call this, but
 * the helper is co-located so the encryption / decryption pair stays
 * symmetric and a test can round-trip without pulling the route.
 */
export function decryptInvoicePayload(ciphertext: Uint8Array, dek: Uint8Array): Uint8Array {
  if (ciphertext.byteLength <= NONCE_BYTES + TAG_BYTES) {
    throw new Error('decryptInvoicePayload: ciphertext shorter than nonce + tag');
  }
  if (dek.byteLength !== DEK_BYTES) {
    throw new Error(`decryptInvoicePayload: DEK must be ${DEK_BYTES} bytes`);
  }
  const nonce = ciphertext.subarray(0, NONCE_BYTES);
  const tag = ciphertext.subarray(ciphertext.byteLength - TAG_BYTES);
  const body = ciphertext.subarray(NONCE_BYTES, ciphertext.byteLength - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(dek), Buffer.from(nonce));
  decipher.setAuthTag(Buffer.from(tag));
  const plain = Buffer.concat([decipher.update(Buffer.from(body)), decipher.final()]);
  return new Uint8Array(plain);
}
