/**
 * Browser-side MD5-of-ciphertext helper for attachment uploads.
 *
 * Extracted from `state/attachmentStore.ts` so the import-orchestrator
 * (`ui/management/importAllFromZip.ts`) and the standard upload path
 * share one implementation. Both routes need RFC 1864 base64 of the
 * 16-byte digest — that is what the server signs into the presigned
 * PUT's `Content-MD5` header (ADR-0024 / api.md §14.2.11), and what
 * the storage provider verifies the body against.
 *
 * Streams `SparkMD5.ArrayBuffer` in 2 MiB chunks so the full bytes
 * never materialize twice in memory; cheap on phones, fast enough that
 * no Web Worker is warranted at the per-file cap.
 */

import SparkMD5 from 'spark-md5';

const CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * Compute the RFC 1864 base64 MD5 of `blob`. Returns the canonical
 * 24-character `==`-padded form the server expects.
 */
export async function computeMd5Base64(blob: Blob): Promise<string> {
  const hasher = new SparkMD5.ArrayBuffer();
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    const slice = blob.slice(offset, Math.min(offset + CHUNK_BYTES, blob.size));
    const buf = await slice.arrayBuffer();
    hasher.append(buf);
  }
  // SparkMD5 yields the 16-byte digest as a hex string; convert to
  // base64 by walking pairs of hex chars into bytes. Browsers don't
  // ship a hex→base64 helper, but `btoa` over a binary string does.
  const hex = hasher.end();
  let bin = '';
  for (let i = 0; i < hex.length; i += 2) {
    bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(bin);
}
