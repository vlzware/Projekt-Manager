/**
 * Browser-side export-all zip assembler (issue #162, AC-249/250/252).
 *
 * Streams a single zip archive carrying:
 *   - `data.json`      — the unified ExportEnvelope, JSON-serialised.
 *   - `attachments/<sanitised-projektnummer>-<sanitised-projekt-titel>/<attachment-id>-<sanitised-fileName>`
 *                      — per-attachment plaintext bytes, AES-256-GCM-decrypted
 *                        from the ciphertext fetched via the injected
 *                        `fetchCiphertext`. Entries with the
 *                        `error = 'DEK_UNWRAP_FAILED'` discriminator are
 *                        skipped (no fetch attempted, no zip entry, no
 *                        manifest entry).
 *   - `manifest.json`  — emitted last; lists `data.json` + every attachment
 *                        that landed, in cursor order, with byte length
 *                        and hex-lowercase SHA-256 (AC-252).
 *
 * Path-component sanitisation matches AC-245 / AC-250: each of the three
 * components (`attachments`, the `<projektnummer>-<projekt-titel>` middle
 * dir, and the `<attachment-id>-<fileName>` leaf) has control chars
 * (`\x00`–`\x1F`, `\x7F`), path separators (`/`, `\`), and double-quotes
 * (`"`) replaced with `_`, then is truncated at 255 chars.
 *
 * Streaming discipline: `client-zip`'s `makeZip` consumes the per-file
 * generator lazily and serialises entries one at a time, so peak memory
 * scales with the largest in-flight plaintext rather than the whole
 * archive. SHA-256 + byte count for each entry are captured by tapping
 * the per-entry stream as it flows through the zipper; once all
 * attachments have streamed, the manifest is built from the accumulator
 * and yielded as the final entry. The manifest itself is NOT listed in
 * the manifest (AC-252).
 */

import { makeZip } from 'client-zip';

import { decodeDekMaterial, decryptBlob } from '@/domain/clientEncryption';

/**
 * Subset of the binary-descriptor surface this helper reads. Mirrors
 * `docs/spec/api.md §14.2.4` / `data-model.md §5.8`. Pulled in locally
 * (rather than imported from a shared types module) so a refactor in the
 * descriptor surface doesn't cascade silently into the assembler.
 */
export interface BinaryDescriptor {
  attachmentId: string;
  projectId: string;
  projectNumber: string;
  projectTitle: string;
  fileName: string;
  sizeBytes: number;
  originalUrl?: string;
  originalDekMaterial?: string;
  expiresAt?: string;
  error?: 'DEK_UNWRAP_FAILED';
}

export interface DescriptorPage {
  entries: BinaryDescriptor[];
  nextCursor: string | null;
  totalCount: number;
  totalSizeBytes: number;
}

export interface ExportEnvelope {
  schema_version: number;
  exported_at: string;
  customers: unknown[];
  projects: unknown[];
  project_workers: unknown[];
}

export interface AssembleExportAllZipInput {
  envelope: ExportEnvelope;
  descriptorPages: AsyncIterable<DescriptorPage>;
  fetchCiphertext: (url: string) => Promise<Uint8Array>;
}

export interface ManifestEntry {
  zipPath: string;
  sizeBytes: number;
  sha256: string;
  attachmentId?: string;
}

export interface Manifest {
  manifestVersion: 1;
  exportedAt: string;
  totalFiles: number;
  totalBytes: number;
  files: ManifestEntry[];
}

const PATH_COMPONENT_MAX = 255;
// AC-245: replace control chars (\x00-\x1F, \x7F), path separators (/, \),
// and double-quote (") with `_`. Built once at module load. The control-
// char class is the whole point — disable the lint rule that nudges
// against it.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_RE = /[\x00-\x1F\x7F/\\"]/g;

/**
 * Per-component AC-245 sanitisation. Replaces every forbidden char with
 * `_`, then truncates to 255 chars. Truncation is by JS string length —
 * the spec wording is "255-character ceiling". For non-ASCII the byte
 * length on disk may exceed 255, but the contract is on chars, not
 * bytes; the test fixtures are ASCII so the two coincide.
 */
function sanitiseComponent(raw: string): string {
  const replaced = raw.replace(FORBIDDEN_RE, '_');
  return replaced.length > PATH_COMPONENT_MAX ? replaced.slice(0, PATH_COMPONENT_MAX) : replaced;
}

/**
 * Build the in-zip path for an attachment entry per AC-250:
 *   `attachments/<sanitised-projektnummer>-<sanitised-projekt-titel>/<attachment-id>-<sanitised-fileName>`
 * The middle dir and leaf are each one path component; the prepended
 * `attachment-id` defuses `(projektnummer, fileName)` collisions across
 * rows. The `attachment-id` is the row's UUID and is NOT subject to
 * sanitisation — UUIDs only carry `[0-9a-f-]`.
 */
function buildAttachmentPath(d: BinaryDescriptor): string {
  const middle = sanitiseComponent(`${d.projectNumber}-${d.projectTitle}`);
  const leaf = sanitiseComponent(`${d.attachmentId}-${d.fileName}`);
  return `attachments/${middle}/${leaf}`;
}

/**
 * Hex-lowercase SHA-256 of `bytes`. Acceptable as a one-shot for the
 * fixture sizes in scope (per-attachment cap is enforced server-side);
 * an incremental digest is the correct upgrade if very large blobs land
 * here, but WebCrypto exposes no incremental API so the upgrade would
 * require a third-party hasher. Out of scope for this helper.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // WebCrypto's `digest` requires plain ArrayBuffer-backed storage on TS
  // 5.7+; copy into a fresh ArrayBuffer to satisfy the overload.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Wrap `bytes` as a single-chunk `ReadableStream<Uint8Array>` for
 * `client-zip`. Matches the pattern used in `attachmentStore.ts` for
 * per-project bulk-zip — the zipper's per-file streaming property is
 * preserved by its serialisation; chunking the in-memory plaintext adds
 * no benefit at the per-file caps in scope.
 */
function bytesAsStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Assemble the export-all zip as a streaming `ReadableStream<Uint8Array>`.
 *
 * The returned stream is the zip body — caller wires it to a download
 * sink (e.g. a `<a download>` blob URL or the response body of a SW
 * fetch). The function returns synchronously; all I/O happens lazily as
 * `client-zip` pulls from the per-file generator.
 */
export function assembleExportAllZip(input: AssembleExportAllZipInput): ReadableStream<Uint8Array> {
  const { envelope, descriptorPages, fetchCiphertext } = input;

  // Accumulator for manifest entries. Filled in as `client-zip` consumes
  // each per-file stream via the tap below, then serialised into the
  // final `manifest.json` entry. Lives in closure scope so the generator
  // and the manifest emitter share state without prop-drilling.
  const manifestFiles: ManifestEntry[] = [];

  const dataJsonBytes = new TextEncoder().encode(JSON.stringify(envelope));

  async function* zipInputs(): AsyncIterable<{
    name: string;
    input: ReadableStream<Uint8Array>;
  }> {
    // 1. data.json — the unified envelope. Hash + size are known up
    //    front (one-shot serialise above) so we record the manifest
    //    entry before yielding rather than tapping the stream.
    manifestFiles.push({
      zipPath: 'data.json',
      sizeBytes: dataJsonBytes.byteLength,
      sha256: await sha256Hex(dataJsonBytes),
    });
    yield { name: 'data.json', input: bytesAsStream(dataJsonBytes) };

    // 2. Attachments — fetch ciphertext, AES-256-GCM-decrypt, emit
    //    plaintext. Skip rows tagged `error = 'DEK_UNWRAP_FAILED'`: the
    //    server already signalled the wrap-key was unavailable, so
    //    there is nothing to decrypt and no fetch should be attempted
    //    (AC-251 + the test's "MUST NOT call fetch for the error row"
    //    invariant).
    for await (const page of descriptorPages) {
      for (const descriptor of page.entries) {
        if (descriptor.error === 'DEK_UNWRAP_FAILED') continue;
        if (!descriptor.originalUrl || !descriptor.originalDekMaterial) {
          // A descriptor missing the fetch triple but without the error
          // discriminator is a server-surface bug — skip rather than
          // crash, the export should still complete for the rest.
          continue;
        }

        const ciphertext = await fetchCiphertext(descriptor.originalUrl);
        const dek = decodeDekMaterial(descriptor.originalDekMaterial);
        const plaintext = await decryptBlob(ciphertext, dek);
        const zipPath = buildAttachmentPath(descriptor);

        manifestFiles.push({
          zipPath,
          sizeBytes: plaintext.byteLength,
          sha256: await sha256Hex(plaintext),
          attachmentId: descriptor.attachmentId,
        });

        yield { name: zipPath, input: bytesAsStream(plaintext) };
      }
    }

    // 3. manifest.json — built from the accumulator and yielded last so
    //    every attachment hash is settled before the manifest is
    //    serialised. The manifest does NOT list itself (AC-252).
    const manifest: Manifest = {
      manifestVersion: 1,
      exportedAt: envelope.exported_at,
      totalFiles: manifestFiles.length,
      totalBytes: manifestFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
      files: manifestFiles,
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    yield { name: 'manifest.json', input: bytesAsStream(manifestBytes) };
  }

  return makeZip(zipInputs());
}
