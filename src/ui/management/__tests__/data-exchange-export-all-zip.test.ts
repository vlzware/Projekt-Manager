/**
 * Unit tests — browser-side export-all zip assembly (AC-250).
 *
 * Pins the zip-layout contract for the streaming-zip helper that lives
 * one level up from this file:
 *
 *   src/ui/management/exportAllAsZip.ts → assembleExportAllZip
 *
 * The helper does not exist yet — this is the red phase of TDD. The
 * test will fail at module resolution until step 5 lands the file. That
 * is acceptable per the working brief; the contract pinned here is the
 * implementer's target.
 *
 * Assumed helper shape (adapt in step 5 if a cleaner shape emerges,
 * but keep the data-flow direction):
 *
 *   import { assembleExportAllZip } from '../exportAllAsZip';
 *
 *   const stream = assembleExportAllZip({
 *     envelope,                  // ExportEnvelope (data-model.md §5.8)
 *     descriptorPages,           // AsyncIterable<DescriptorPage>
 *     fetchCiphertext,           // (url: string) => Promise<Uint8Array>
 *   });
 *
 *   // Returns ReadableStream<Uint8Array> — the zip body. Tests collect
 *   // the bytes, parse the central directory, and assert layout / byte
 *   // equality.
 *
 * Why a `fetchCiphertext` injection? AC-250 is a per-entry byte-equality
 * assertion (decrypt-roundtrip on a fixture). Injecting the fetcher lets
 * the test feed canned ciphertext for canned URLs without a `vi.spyOn`
 * on `globalThis.fetch` — the network is not the boundary under test.
 *
 * AC coverage in this file:
 *   - AC-250: `data.json` at the zip root, round-trips through
 *             JSON.parse to the input envelope; fetchable entries land at
 *             `attachments/<sanitised-projektnummer>-<sanitised-projekt-titel>/<attachment-id>-<sanitised-fileName>`;
 *             AC-245-style sanitisation (255-char ceiling per component,
 *             control chars / path separators / `"` replaced with `_`,
 *             length truncated); a forced
 *             `(projektnummer, fileName)` collision across two rows is
 *             defused by the prepended `attachment-id`; entries with
 *             `error = 'DEK_UNWRAP_FAILED'` are absent from the zip;
 *             plaintext bytes inside the zip equal the original
 *             plaintext (decrypt-roundtrip assertion).
 *   - AC-252: `manifest.json` at the zip root with shape
 *             `{ manifestVersion, exportedAt, totalFiles, totalBytes, files[] }`;
 *             `files[0]` is `data.json`; subsequent entries are the
 *             attachments in cursor order; each entry's `sha256` equals
 *             SHA-256(bytes-at-zipPath) hex-lowercase; attachment entries
 *             carry `attachmentId`, the `data.json` entry does not;
 *             skipped attachments are NOT listed; the manifest does not
 *             list itself; `totalFiles === files.length`,
 *             `totalBytes === sum(files[*].sizeBytes)`.
 *
 * Test fixtures are tiny by design (a few bytes per file). The
 * decrypt-roundtrip is the only real-crypto path — `clientEncryption.ts`
 * runs against Node 22's `globalThis.crypto`, so the AES-256-GCM
 * encrypt + base64-encode are the canonical pre-image for what the
 * descriptor surface would normally hand the helper.
 */

import { describe, it, expect } from 'vitest';
import { encryptBlob, generateDek, encodeDekMaterial } from '@/domain/clientEncryption';

// Importing the not-yet-existent helper. Module resolution will fail in
// the red phase — that is the documented expected mode for this file.
import { assembleExportAllZip } from '../exportAllAsZip';

/**
 * Minimal STORE-mode zip parser. `client-zip` (the project's streaming-
 * zip lib) always emits STORE entries for typed-array inputs, but the
 * sizes are NOT written into the local file header — they are deferred
 * to a Data Descriptor record after the file bytes (general-purpose bit
 * flag 0x0008 set; LFH compressed/uncompressed-size fields zeroed).
 * That is the streaming-mode layout per APPNOTE.TXT §4.3.9. Pulled
 * inline rather than adding a `fflate`/`jszip` dev-dep just to read
 * back what we just wrote.
 *
 * Shape per APPNOTE.TXT §4.3.7 + §4.3.9:
 *   local file header signature: 0x04034b50  (PK\x03\x04)
 *   …, general-purpose bit flag (0x0008 = sizes in data descriptor), …,
 *   compression method (=0 for STORE), …,
 *   compressed size (0 when bit 3 of flags is set, real value otherwise),
 *   uncompressed size (same — 0 when streaming),
 *   filename length, extra-field length,
 *   filename bytes, extra-field bytes,
 *   file bytes,
 *   [optional: data descriptor signature 0x08074b50, then crc32, compressed
 *    size, uncompressed size — present iff bit 3 of the flags was set].
 *
 * The central directory at the end is ignored — every entry is
 * recoverable from the local headers + data descriptors alone. A
 * non-STORE entry throws.
 */
function parseZipEntries(zip: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let off = 0;
  const LFH_SIG = 0x04034b50;
  const DD_SIG = 0x08074b50; // data descriptor (optional preamble)
  while (off + 30 <= zip.byteLength) {
    const sig = view.getUint32(off, true);
    if (sig !== LFH_SIG) break; // hit central directory or end-of-central-dir
    const flags = view.getUint16(off + 6, true);
    const compressionMethod = view.getUint16(off + 8, true);
    const lfhCompressedSize = view.getUint32(off + 18, true);
    const lfhUncompressedSize = view.getUint32(off + 22, true);
    const fnLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    if (compressionMethod !== 0) {
      throw new Error(
        `parseZipEntries: expected STORE (0), got compression method ${compressionMethod}`,
      );
    }
    const fnStart = off + 30;
    const fnBytes = zip.subarray(fnStart, fnStart + fnLen);
    const fileName = new TextDecoder('utf-8').decode(fnBytes);
    const dataStart = fnStart + fnLen + extraLen;

    let entrySize: number;
    let nextOff: number;
    if ((flags & 0x0008) !== 0) {
      // Streaming-mode entry: walk forward to find the data descriptor
      // signature, which marks the end of the file payload. The
      // descriptor's signature is technically optional in the spec but
      // is universally written by streaming zip writers (`client-zip`
      // included). Bytes between dataStart and the DD_SIG match are the
      // file payload.
      let probe = dataStart;
      const limit = zip.byteLength - 16; // dd is signature + 12 bytes minimum
      while (probe <= limit) {
        if (view.getUint32(probe, true) === DD_SIG) {
          // Cross-check: the descriptor's compressed-size field
          // (offset +8 from sig) should equal `probe - dataStart`. If
          // not, the signature was a coincidence inside the payload —
          // keep scanning. Cheap and effective for ASCII payloads (the
          // test fixtures); for binary a more robust approach would
          // walk from the central directory, but we're STORE-only and
          // the fixtures are tiny.
          const ddCompressed = view.getUint32(probe + 8, true);
          if (ddCompressed === probe - dataStart) break;
        }
        probe += 1;
      }
      entrySize = probe - dataStart;
      nextOff = probe + 16; // sig (4) + crc (4) + compSize (4) + uncompSize (4)
    } else {
      // Sizes in LFH are authoritative.
      if (lfhCompressedSize !== lfhUncompressedSize) {
        throw new Error(
          `parseZipEntries: STORE entry has compressedSize ${lfhCompressedSize} ≠ uncompressedSize ${lfhUncompressedSize}`,
        );
      }
      entrySize = lfhCompressedSize;
      nextOff = dataStart + entrySize;
    }

    const data = zip.slice(dataStart, dataStart + entrySize);
    out.set(fileName, data);
    off = nextOff;
  }
  return out;
}

// ---------------------------------------------------------------
// Local copies of the descriptor / envelope shapes the helper consumes.
// Pulled inline rather than importing from the spec so a refactor of
// the type names in the implementation does not silently break this
// file at compile-time before step 5 has wired the imports.
// ---------------------------------------------------------------
interface BinaryDescriptor {
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

interface DescriptorPage {
  entries: BinaryDescriptor[];
  nextCursor: string | null;
  totalCount: number;
  totalSizeBytes: number;
}

interface ExportEnvelope {
  schema_version: number;
  exported_at: string;
  customers: unknown[];
  projects: unknown[];
  project_workers: unknown[];
}

/** Drain the ReadableStream the helper returns into one Uint8Array. */
async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Build a one-page async iterable of descriptor pages. Helpers wrap a
 * plain array so each test can describe the iteration set declaratively.
 */
function pagesOf(entries: BinaryDescriptor[]): AsyncIterable<DescriptorPage> {
  const page: DescriptorPage = {
    entries,
    nextCursor: null,
    totalCount: entries.filter((e) => !e.error).length,
    totalSizeBytes: entries.reduce((sum, e) => (e.error ? sum : sum + e.sizeBytes), 0),
  };
  async function* gen(): AsyncIterable<DescriptorPage> {
    yield page;
  }
  return gen();
}

/**
 * Encrypt `plaintext` under a fresh DEK and return both halves so the
 * test can stage a fetch that returns the ciphertext bytes AND embed
 * the matching DEK material in the descriptor — the same shape the
 * server's binary-descriptors surface would hand over.
 */
async function makeFetchableFixture(plaintext: Uint8Array): Promise<{
  ciphertext: Uint8Array;
  dekMaterial: string;
}> {
  const dek = generateDek();
  const ciphertext = await encryptBlob(plaintext, dek);
  return { ciphertext, dekMaterial: encodeDekMaterial(dek) };
}

/**
 * Minimal envelope used as the `data.json` fixture. Content is
 * intentionally trivial — AC-250 is about layout + byte-equality
 * relative to what the caller passed in, not envelope shape.
 */
function buildEnvelope(): ExportEnvelope {
  return {
    schema_version: 1,
    exported_at: '2026-05-03T10:00:00.000Z',
    customers: [],
    projects: [],
    project_workers: [],
  };
}

describe('AC-250: zip layout', () => {
  it('data.json at zip root — round-trips through JSON.parse to the input envelope', async () => {
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('hello'));
    const descriptor: BinaryDescriptor = {
      attachmentId: '11111111-0000-4000-8000-000000000001',
      projectId: 'p1',
      projectNumber: '2026-001',
      projectTitle: 'Projekt Eins',
      fileName: 'note.txt',
      sizeBytes: 5,
      originalUrl: 'https://storage.test/att-1.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };

    const fetchCiphertext = async (url: string): Promise<Uint8Array> => {
      if (url === descriptor.originalUrl) return fix.ciphertext;
      throw new Error(`unexpected fetch ${url}`);
    };

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([descriptor]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);

    // data.json sits at the root, not under any subdir.
    expect(entries.has('data.json')).toBe(true);
    // AC-250 says the zip "carries `data.json` (the unified envelope)
    // at the root" — no byte-for-byte requirement on the wire. The
    // helper owns the JSON serialisation (pretty-print vs. compact is
    // implementation-defined); the test parses the zip entry back and
    // asserts deep equality on the parsed value. That is what the
    // contract pins: round-trip identity, not byte-equality.
    const dataJson = new TextDecoder('utf-8').decode(entries.get('data.json')!);
    const parsed = JSON.parse(dataJson) as ExportEnvelope;
    expect(parsed).toEqual(envelope);
  });

  it('places fetchable entries under attachments/<sanitised-projektnummer>-<sanitised-projekt-titel>/<attachment-id>-<sanitised-fileName>', async () => {
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('payload'));
    const attachmentId = '22222222-0000-4000-8000-000000000002';
    const descriptor: BinaryDescriptor = {
      attachmentId,
      projectId: 'p1',
      projectNumber: '2026-042',
      projectTitle: 'Projekt Zwei',
      fileName: 'invoice.pdf',
      sizeBytes: fix.ciphertext.byteLength - 28,
      originalUrl: 'https://storage.test/att-2.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };

    const fetchCiphertext = async (url: string): Promise<Uint8Array> => {
      if (url === descriptor.originalUrl) return fix.ciphertext;
      throw new Error(`unexpected fetch ${url}`);
    };

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([descriptor]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);

    const expectedPath = `attachments/2026-042-Projekt Zwei/${attachmentId}-invoice.pdf`;
    expect(entries.has(expectedPath)).toBe(true);
  });

  it('sanitises path components per AC-245: control chars, `/`, `\\`, and `"` become `_`', async () => {
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('san'));
    const attachmentId = '33333333-0000-4000-8000-000000000003';
    const descriptor: BinaryDescriptor = {
      attachmentId,
      projectId: 'p1',
      // Embed every category of forbidden character: a `/`, a `\`, a
      // double-quote, and a control byte (0x07 = BEL). Each one must
      // reduce to `_`.
      projectNumber: '2026/099',
      projectTitle: 'A"B\\CD',
      fileName: 'na/me.pdf',
      sizeBytes: fix.ciphertext.byteLength - 28,
      originalUrl: 'https://storage.test/att-3.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };

    const fetchCiphertext = async (): Promise<Uint8Array> => fix.ciphertext;

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([descriptor]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);

    // Build the expected path: every forbidden char in the components
    // is `_`. The middle dir is `<sanitised-projektnummer>-<sanitised-title>`.
    const expectedPath = `attachments/2026_099-A_B_C_D/${attachmentId}-na_me.pdf`;
    expect(entries.has(expectedPath)).toBe(true);
  });

  it('truncates each path component at 255 characters', async () => {
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('len'));
    const attachmentId = '44444444-0000-4000-8000-000000000004';
    // 300-char fileName — AC-245 truncates per-component to 255.
    const longFileName = 'x'.repeat(300);
    const descriptor: BinaryDescriptor = {
      attachmentId,
      projectId: 'p1',
      projectNumber: '2026-001',
      projectTitle: 'Eins',
      fileName: longFileName,
      sizeBytes: fix.ciphertext.byteLength - 28,
      originalUrl: 'https://storage.test/att-4.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };

    const fetchCiphertext = async (): Promise<Uint8Array> => fix.ciphertext;

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([descriptor]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);

    // The leaf path component is `<attachment-id>-<sanitised-fileName>`;
    // the per-component ceiling is 255. The whole leaf must therefore be
    // ≤ 255 bytes long. Using bytes (not chars) because the spec wording
    // is "255-character ceiling" but file-system limits are bytes; the
    // test uses ASCII so the two coincide.
    const leaves = Array.from(entries.keys())
      .filter((k) => k.startsWith('attachments/'))
      .map((k) => k.split('/').pop()!);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.length).toBeLessThanOrEqual(255);
  });

  it('a forced (projektnummer, fileName) collision across two rows resolves cleanly via the prepended attachment-id', async () => {
    const envelope = buildEnvelope();
    const fixA = await makeFetchableFixture(new TextEncoder().encode('A-bytes'));
    const fixB = await makeFetchableFixture(new TextEncoder().encode('B-bytes'));
    // Same projektnummer / projektTitel / fileName — only attachmentId
    // differentiates the two rows. The prepended attachment-id is the
    // collision-defusing knob per AC-250.
    const a: BinaryDescriptor = {
      attachmentId: 'aaaaaaaa-0000-4000-8000-00000000000a',
      projectId: 'p1',
      projectNumber: '2026-007',
      projectTitle: 'Sammlung',
      fileName: 'doc.pdf',
      sizeBytes: 7,
      originalUrl: 'https://storage.test/A.ct',
      originalDekMaterial: fixA.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };
    const b: BinaryDescriptor = {
      attachmentId: 'bbbbbbbb-0000-4000-8000-00000000000b',
      projectId: 'p1',
      projectNumber: '2026-007',
      projectTitle: 'Sammlung',
      fileName: 'doc.pdf',
      sizeBytes: 7,
      originalUrl: 'https://storage.test/B.ct',
      originalDekMaterial: fixB.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };

    const fetchCiphertext = async (url: string): Promise<Uint8Array> => {
      if (url === a.originalUrl) return fixA.ciphertext;
      if (url === b.originalUrl) return fixB.ciphertext;
      throw new Error(`unexpected fetch ${url}`);
    };

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([a, b]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);

    // Both entries land — distinct paths because attachmentId differs.
    const pathA = `attachments/2026-007-Sammlung/${a.attachmentId}-doc.pdf`;
    const pathB = `attachments/2026-007-Sammlung/${b.attachmentId}-doc.pdf`;
    expect(entries.has(pathA)).toBe(true);
    expect(entries.has(pathB)).toBe(true);
    expect(pathA).not.toEqual(pathB);
  });

  it('omits entries carrying error = "DEK_UNWRAP_FAILED" from the zip', async () => {
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('keep'));
    const ok: BinaryDescriptor = {
      attachmentId: 'cccccccc-0000-4000-8000-00000000000c',
      projectId: 'p1',
      projectNumber: '2026-001',
      projectTitle: 'Eins',
      fileName: 'keep.pdf',
      sizeBytes: 4,
      originalUrl: 'https://storage.test/keep.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };
    const broken: BinaryDescriptor = {
      attachmentId: 'dddddddd-0000-4000-8000-00000000000d',
      projectId: 'p1',
      projectNumber: '2026-001',
      projectTitle: 'Eins',
      fileName: 'skip.pdf',
      sizeBytes: 99,
      // Discriminator: error tag carries no fetch fields.
      error: 'DEK_UNWRAP_FAILED',
    };

    const fetchCiphertext = async (url: string): Promise<Uint8Array> => {
      if (url === ok.originalUrl) return fix.ciphertext;
      // The helper MUST NOT call fetch for the error row — that would
      // be a different bug. Asserting via a thrown error is enough; the
      // helper is supposed to recognise the error tag up front.
      throw new Error(`unexpected fetch ${url}`);
    };

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([ok, broken]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);

    const attachmentPaths = Array.from(entries.keys()).filter((k) => k.startsWith('attachments/'));
    expect(attachmentPaths).toHaveLength(1);
    expect(attachmentPaths[0]).toContain('keep.pdf');
    expect(attachmentPaths[0]).not.toContain('skip.pdf');
  });

  it('decrypt-roundtrip: the bytes inside the zip equal the original plaintext', async () => {
    // The test seeds known plaintext, encrypts under a known DEK,
    // hands the ciphertext + DEK material to the helper, and asserts
    // the bytes extracted from the zip equal the original plaintext.
    // This is the load-bearing AC-250 invariant: the export carries
    // plaintext, not ciphertext.
    const envelope = buildEnvelope();
    const plaintextA = new TextEncoder().encode('Bytes für die Datei A');
    const plaintextB = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const fixA = await makeFetchableFixture(plaintextA);
    const fixB = await makeFetchableFixture(plaintextB);

    const idA = 'eeeeeeee-0000-4000-8000-00000000000e';
    const idB = 'ffffffff-0000-4000-8000-00000000000f';
    const a: BinaryDescriptor = {
      attachmentId: idA,
      projectId: 'p1',
      projectNumber: '2026-100',
      projectTitle: 'A',
      fileName: 'a.txt',
      sizeBytes: plaintextA.byteLength,
      originalUrl: 'https://storage.test/A.ct',
      originalDekMaterial: fixA.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };
    const b: BinaryDescriptor = {
      attachmentId: idB,
      projectId: 'p1',
      projectNumber: '2026-100',
      projectTitle: 'A',
      fileName: 'b.bin',
      sizeBytes: plaintextB.byteLength,
      originalUrl: 'https://storage.test/B.ct',
      originalDekMaterial: fixB.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };

    const fetchCiphertext = async (url: string): Promise<Uint8Array> => {
      if (url === a.originalUrl) return fixA.ciphertext;
      if (url === b.originalUrl) return fixB.ciphertext;
      throw new Error(`unexpected fetch ${url}`);
    };

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([a, b]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);

    const pathA = `attachments/2026-100-A/${idA}-a.txt`;
    const pathB = `attachments/2026-100-A/${idB}-b.bin`;
    expect(entries.has(pathA)).toBe(true);
    expect(entries.has(pathB)).toBe(true);
    // Byte-equality vs. the original plaintext — the helper has
    // decrypted under the supplied DEK and emitted the plaintext into
    // the zip entry. A regression that emitted ciphertext (or used the
    // wrong DEK) breaks the comparison.
    expect(Array.from(entries.get(pathA)!)).toEqual(Array.from(plaintextA));
    expect(Array.from(entries.get(pathB)!)).toEqual(Array.from(plaintextB));
  });
});

/**
 * Hex-lowercase SHA-256. The manifest stores hashes in the same
 * format `sha256sum(1)` emits, so an external verifier can transform
 * `manifest.json` into `sha256sum -c` input with a single `jq`
 * projection. WebCrypto returns an ArrayBuffer; this helper formats
 * it as 64 hex chars from `[0-9a-f]`.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest's BufferSource parameter requires
  // ArrayBuffer-backed storage (not the broader ArrayBufferLike that
  // generic Uint8Array now allows under TS 5.7+). Copy into a fresh
  // ArrayBuffer to satisfy the overload deterministically.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface ManifestEntry {
  zipPath: string;
  sizeBytes: number;
  sha256: string;
  attachmentId?: string;
}

interface Manifest {
  manifestVersion: number;
  exportedAt: string;
  totalFiles: number;
  totalBytes: number;
  files: ManifestEntry[];
}

describe('AC-252: manifest.json', () => {
  it('present at zip root with the documented top-level shape', async () => {
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('hello'));
    const descriptor: BinaryDescriptor = {
      attachmentId: '11111111-0000-4000-8000-000000000001',
      projectId: 'p1',
      projectNumber: '2026-001',
      projectTitle: 'Eins',
      fileName: 'note.txt',
      sizeBytes: 5,
      originalUrl: 'https://storage.test/m1.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };
    const fetchCiphertext = async (): Promise<Uint8Array> => fix.ciphertext;

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([descriptor]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);

    expect(entries.has('manifest.json')).toBe(true);
    const manifest = JSON.parse(
      new TextDecoder('utf-8').decode(entries.get('manifest.json')!),
    ) as Manifest;

    expect(manifest.manifestVersion).toBe(1);
    expect(typeof manifest.exportedAt).toBe('string');
    // ISO 8601 sanity — fully-qualified UTC timestamp.
    expect(manifest.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof manifest.totalFiles).toBe('number');
    expect(typeof manifest.totalBytes).toBe('number');
    expect(Array.isArray(manifest.files)).toBe(true);
    // At minimum: data.json + the one attachment that landed.
    expect(manifest.files).toHaveLength(2);
    expect(manifest.totalFiles).toBe(manifest.files.length);
    expect(manifest.totalBytes).toBe(manifest.files.reduce((sum, f) => sum + f.sizeBytes, 0));
  });

  it('files[0] is data.json (no attachmentId), and every entry has the documented shape', async () => {
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('hello'));
    const descriptor: BinaryDescriptor = {
      attachmentId: '22222222-0000-4000-8000-000000000002',
      projectId: 'p1',
      projectNumber: '2026-002',
      projectTitle: 'Zwei',
      fileName: 'note.txt',
      sizeBytes: 5,
      originalUrl: 'https://storage.test/m2.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };
    const fetchCiphertext = async (): Promise<Uint8Array> => fix.ciphertext;

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([descriptor]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);
    const manifest = JSON.parse(
      new TextDecoder('utf-8').decode(entries.get('manifest.json')!),
    ) as Manifest;

    // First entry is data.json; it does NOT carry attachmentId.
    expect(manifest.files[0]!.zipPath).toBe('data.json');
    expect(manifest.files[0]!.attachmentId).toBeUndefined();

    // Every entry has zipPath, sizeBytes, and a 64-hex sha256.
    for (const entry of manifest.files) {
      expect(typeof entry.zipPath).toBe('string');
      expect(typeof entry.sizeBytes).toBe('number');
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // The attachment entry carries attachmentId.
    const attachmentEntry = manifest.files.find((f) => f.zipPath.startsWith('attachments/'));
    expect(attachmentEntry).toBeDefined();
    expect(attachmentEntry!.attachmentId).toBe(descriptor.attachmentId);
  });

  it('every files[i].sha256 equals SHA-256 of the bytes at files[i].zipPath inside the zip', async () => {
    // The load-bearing AC-252 invariant: the manifest is verifiable
    // standalone — each declared sha256 matches the actual bytes the
    // zip carries at that path. This is what makes external offline
    // verification possible (`sha256sum -c` against the manifest).
    const envelope = buildEnvelope();
    const plaintextA = new TextEncoder().encode('first attachment');
    const plaintextB = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const fixA = await makeFetchableFixture(plaintextA);
    const fixB = await makeFetchableFixture(plaintextB);

    const a: BinaryDescriptor = {
      attachmentId: 'aaaaaaaa-0000-4000-8000-00000000000a',
      projectId: 'p1',
      projectNumber: '2026-100',
      projectTitle: 'Mani',
      fileName: 'a.txt',
      sizeBytes: plaintextA.byteLength,
      originalUrl: 'https://storage.test/mA.ct',
      originalDekMaterial: fixA.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };
    const b: BinaryDescriptor = {
      attachmentId: 'bbbbbbbb-0000-4000-8000-00000000000b',
      projectId: 'p1',
      projectNumber: '2026-100',
      projectTitle: 'Mani',
      fileName: 'b.bin',
      sizeBytes: plaintextB.byteLength,
      originalUrl: 'https://storage.test/mB.ct',
      originalDekMaterial: fixB.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };

    const fetchCiphertext = async (url: string): Promise<Uint8Array> => {
      if (url === a.originalUrl) return fixA.ciphertext;
      if (url === b.originalUrl) return fixB.ciphertext;
      throw new Error(`unexpected fetch ${url}`);
    };

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([a, b]),
      fetchCiphertext,
    });
    const zipBytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(zipBytes);
    const manifest = JSON.parse(
      new TextDecoder('utf-8').decode(entries.get('manifest.json')!),
    ) as Manifest;

    // Per AC-252: data.json first, then attachments in cursor order.
    expect(manifest.files.map((f) => f.zipPath)).toEqual([
      'data.json',
      `attachments/2026-100-Mani/${a.attachmentId}-a.txt`,
      `attachments/2026-100-Mani/${b.attachmentId}-b.bin`,
    ]);

    // sha256 verification — recompute over the bytes the zip carries
    // and assert equality with what the manifest declares. This is the
    // exact loop an external verifier would run.
    for (const entry of manifest.files) {
      const bytesAtPath = entries.get(entry.zipPath);
      expect(bytesAtPath).toBeDefined();
      expect(bytesAtPath!.byteLength).toBe(entry.sizeBytes);
      const recomputed = await sha256Hex(bytesAtPath!);
      expect(recomputed).toBe(entry.sha256);
    }
  });

  it('manifest.json is NOT listed inside itself', async () => {
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('x'));
    const descriptor: BinaryDescriptor = {
      attachmentId: 'cccccccc-0000-4000-8000-00000000000c',
      projectId: 'p1',
      projectNumber: '2026-003',
      projectTitle: 'Drei',
      fileName: 'x.txt',
      sizeBytes: 1,
      originalUrl: 'https://storage.test/m3.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };
    const fetchCiphertext = async (): Promise<Uint8Array> => fix.ciphertext;

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([descriptor]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);
    const manifest = JSON.parse(
      new TextDecoder('utf-8').decode(entries.get('manifest.json')!),
    ) as Manifest;

    expect(manifest.files.some((f) => f.zipPath === 'manifest.json')).toBe(false);
  });

  it('skipped attachments (DEK_UNWRAP_FAILED) are NOT listed in the manifest', async () => {
    // Parity with AC-250: the manifest lists what is IN the zip, not
    // what was attempted. A skipped row is absent from both.
    const envelope = buildEnvelope();
    const fix = await makeFetchableFixture(new TextEncoder().encode('keep'));
    const ok: BinaryDescriptor = {
      attachmentId: 'dddddddd-0000-4000-8000-00000000000d',
      projectId: 'p1',
      projectNumber: '2026-004',
      projectTitle: 'Vier',
      fileName: 'keep.pdf',
      sizeBytes: 4,
      originalUrl: 'https://storage.test/m4.ct',
      originalDekMaterial: fix.dekMaterial,
      expiresAt: '2026-05-03T10:05:00.000Z',
    };
    const broken: BinaryDescriptor = {
      attachmentId: 'eeeeeeee-0000-4000-8000-00000000000e',
      projectId: 'p1',
      projectNumber: '2026-004',
      projectTitle: 'Vier',
      fileName: 'skip.pdf',
      sizeBytes: 99,
      error: 'DEK_UNWRAP_FAILED',
    };
    const fetchCiphertext = async (url: string): Promise<Uint8Array> => {
      if (url === ok.originalUrl) return fix.ciphertext;
      throw new Error(`unexpected fetch ${url}`);
    };

    const stream = assembleExportAllZip({
      envelope,
      descriptorPages: pagesOf([ok, broken]),
      fetchCiphertext,
    });
    const bytes = await readStreamToBytes(stream);
    const entries = parseZipEntries(bytes);
    const manifest = JSON.parse(
      new TextDecoder('utf-8').decode(entries.get('manifest.json')!),
    ) as Manifest;

    // data.json + the one attachment that landed; the broken row is
    // absent from both the zip and the manifest.
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files.some((f) => f.attachmentId === broken.attachmentId)).toBe(false);
    expect(manifest.files.some((f) => f.attachmentId === ok.attachmentId)).toBe(true);
  });
});
