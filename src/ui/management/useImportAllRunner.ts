/**
 * Vollständiger Import — runner hook (issue #163, AC-259/AC-260/AC-261).
 *
 * Owns the import state machine the `VollstaendigerImportDialog` renders
 * against. Mirrors `useExportAllRunner.ts` in shape: the hook exposes a
 * discriminated-union `phase`, `start(file, phrase)` / `cancel()`, and
 * keeps the dialog component declarative.
 *
 * State machine:
 *   closed
 *      └→ awaiting-file       (dialog open, no zip selected yet)
 *           └→ preflight       (zip parsed + manifest valid; user gates)
 *                └→ progress   (text-leg + per-attachment legs running)
 *                     └→ summary | error
 *
 * Concurrency / cancellation:
 *   - The orchestrator is the single async dispatch point. The hook
 *     wires an `AbortSignal` through; cancel fires the signal and
 *     waits for the orchestrator to settle.
 *   - The orchestrator's per-file failures land in `summary.failures`
 *     so the dialog can render the "X Anhänge übersprungen" line.
 *
 * Crypto / image-pipeline reuse:
 *   The runner threads `prepareAttachment` through to the orchestrator.
 *   The prepare step runs the standard image pipeline for photos
 *   (`runImagePipeline`), generates a fresh DEK + nonce, encrypts both
 *   blobs, and computes RFC 1864 base64 MD5 of each ciphertext — the
 *   exact same shape the standard upload path runs in
 *   `attachmentStore.runUpload`. The shared `computeMd5Base64` helper
 *   lives in `domain/attachmentChecksum.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { validateLabel } from '@/domain/attachments';
import { computeMd5Base64 } from '@/domain/attachmentChecksum';
import { encodeDekMaterial, encryptBlob, generateDek } from '@/domain/clientEncryption';
import { SCHEMA_VERSION } from '@/domain/dataExchange';
import { deriveWebpThumbnail } from '@/domain/imagePipeline';
import { importAllApi } from '@/state/importAllStore';
import {
  importAllFromZip,
  parseTakeoutZip,
  type ImportAllResult,
  type ImportEnvelope,
  type ImportEnvelopeAttachment,
  type ImportFailure,
  type InitAttachmentResult,
  type ParsedTakeoutZip,
  type PrepareAttachmentInput,
  type PrepareAttachmentResult,
  type RestoreBlock,
} from './importAllFromZip';

export type DialogPhase =
  | { kind: 'closed' }
  | { kind: 'awaiting-file' }
  | PreflightPhase
  | ProgressPhase
  | SummaryPhase
  | ErrorPhase;

export interface PreflightSnapshot {
  envelope: ImportEnvelope;
  attachmentCount: number;
  totalBytes: number;
  /** Whether the importing instance is currently non-empty (drives the phrase prompt). */
  targetNonEmpty: boolean;
}

export interface PreflightPhase extends PreflightSnapshot {
  kind: 'preflight';
}

export interface ProgressPhase {
  kind: 'progress';
  totalCount: number;
  totalSizeBytes: number;
  filesDone: number;
  bytesDone: number;
  currentFile: string;
}

export interface SummaryPhase {
  kind: 'summary';
  committedCount: number;
  totalAttachments: number;
  failures: ImportFailure[];
}

export interface ErrorPhase {
  kind: 'error';
  message: string;
}

/**
 * Result the hook needs from the dry-run preview to decide whether the
 * confirmation phrase prompt is required. Subset of `DryRunPreview`.
 */
interface PreviewLite {
  targetNonEmpty: boolean;
}

/**
 * Wrap the bytes via a Blob so the shared `computeMd5Base64` helper
 * (which expects a Blob, matching the upload pipeline's signature) can
 * read them in 2 MiB chunks.
 */
function bytesToBlob(bytes: Uint8Array): Blob {
  // The Blob constructor on TS 5.x narrows the input from
  // `Uint8Array<ArrayBufferLike>` — wrap via the underlying ArrayBuffer
  // slice to satisfy the type. Runtime is identical.
  return new Blob([bytes.buffer.slice(0) as ArrayBuffer], {
    type: 'application/octet-stream',
  });
}

/**
 * Build the orchestrator's `prepareAttachment` callback. Encapsulates
 * DEK generation, MD5 of each ciphertext, and (for photos) the image
 * pipeline thumbnail derivation. Mirrors `attachmentStore.runUpload`'s
 * Step 3+4 shape.
 */
async function prepareAttachment(input: PrepareAttachmentInput): Promise<PrepareAttachmentResult> {
  const { entry, plaintext } = input;

  // The original is forwarded verbatim — the takeout-zip plaintext is
  // already the post-pipeline output of the source export (downscale +
  // re-encode happened on the way OUT, not on the way IN). Re-running
  // the pipeline here would lossy-re-encode the JPEG and break the
  // byte-equality contract pinned by AC-241 / AC-259. The thumbnail
  // is derived from those same bytes via the canvas helper so the
  // gallery has something to render after restore (mirrors the spec
  // wording in issue #163: "Thumbnails restore naturally — the
  // browser-side pipeline … derives thumbs").
  const originalBlob = bytesToBlob(plaintext);

  // Derive thumbnail for photos only — `deriveWebpThumbnail` returns
  // null in non-browser runtimes (jsdom, the unit tests don't reach
  // this branch) so the caller falls back to a no-thumbnail upload.
  const thumbnailBlob = entry.kind === 'photo' ? await deriveWebpThumbnail(originalBlob) : null;
  const willUploadThumb = thumbnailBlob !== null;

  // Encrypt original.
  const originalDek = generateDek();
  const originalCiphertext = await encryptBlob(plaintext, originalDek);
  const originalCiphertextBlob = new Blob([originalCiphertext.buffer.slice(0) as ArrayBuffer], {
    type: 'application/octet-stream',
  });

  // Encrypt thumbnail (if any).
  let thumbCiphertext: Uint8Array | undefined;
  let thumbCiphertextBlob: Blob | undefined;
  let thumbDek: Uint8Array | undefined;
  if (willUploadThumb && thumbnailBlob) {
    thumbDek = generateDek();
    thumbCiphertext = await encryptBlob(
      new Uint8Array(await thumbnailBlob.arrayBuffer()),
      thumbDek,
    );
    thumbCiphertextBlob = new Blob([thumbCiphertext.buffer.slice(0) as ArrayBuffer], {
      type: 'application/octet-stream',
    });
  }

  // MD5 of each ciphertext for `Content-MD5`.
  const ciphertextMd5 = await computeMd5Base64(originalCiphertextBlob);
  const thumbCiphertextMd5 = thumbCiphertextBlob
    ? await computeMd5Base64(thumbCiphertextBlob)
    : undefined;

  // Narrow the envelope's free-string `label` to the closed
  // `AttachmentLabel` enum at the boundary. `validateLabel` throws on
  // an unknown value — caught by the orchestrator and recorded as a
  // per-file failure rather than aborting the whole run.
  const label = validateLabel(entry.label);

  return {
    initPayload: {
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      sizeBytes: plaintext.byteLength,
      label,
      hasThumbnail: willUploadThumb,
      dekMaterial: encodeDekMaterial(originalDek),
      ciphertextSizeBytes: originalCiphertextBlob.size,
      ciphertextContentMd5: ciphertextMd5,
      ...(willUploadThumb && thumbDek && thumbCiphertextBlob && thumbCiphertextMd5
        ? {
            thumbDekMaterial: encodeDekMaterial(thumbDek),
            ciphertextThumbSizeBytes: thumbCiphertextBlob.size,
            ciphertextThumbContentMd5: thumbCiphertextMd5,
          }
        : {}),
    },
    originalCiphertext,
    ...(thumbCiphertext ? { thumbnailCiphertext: thumbCiphertext } : {}),
  };
}

/**
 * Adapter from the state-layer `importAllApi.importInit` to the
 * orchestrator's plain-promise contract. A non-OK result propagates
 * as a thrown error so the orchestrator's per-file failure branch
 * records it.
 */
async function initAttachment(
  entry: ImportEnvelopeAttachment,
  restore: RestoreBlock,
  payload?: NonNullable<PrepareAttachmentResult>['initPayload'],
): Promise<InitAttachmentResult> {
  if (!payload) {
    throw new Error('initAttachment: prepared payload missing');
  }
  return importAllApi.importInit(entry.projectId, payload, restore);
}

/**
 * PUT a presigned ciphertext. Strips the forbidden `Content-Length`
 * header (browsers refuse it, matching the standard-upload helper in
 * `attachmentStore.putPresigned`).
 */
async function putCiphertext(
  url: string,
  headers: Record<string, string>,
  ciphertext: Uint8Array,
): Promise<void> {
  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-length') continue;
    safeHeaders[k] = v;
  }
  const body = new Blob([ciphertext.buffer.slice(0) as ArrayBuffer], {
    type: 'application/octet-stream',
  });
  const res = await fetch(url, { method: 'PUT', headers: safeHeaders, body });
  if (!res.ok) {
    throw new Error(`PUT failed: status=${res.status}`);
  }
}

/**
 * Read a `File` into a `Uint8Array`. Works in browser and jsdom.
 */
async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export interface UseImportAllRunnerInput {
  isOpen: boolean;
}

export interface UseImportAllRunnerResult {
  phase: DialogPhase;
  /**
   * Pick a takeout-zip and parse it for the preflight readout. The
   * runner caches the parsed envelope + manifest so `start` doesn't
   * re-parse.
   */
  pickFile: (file: File) => Promise<void>;
  /**
   * Begin the import run. Caller passes the typed phrase; the runner
   * passes it to the text-leg POST when `targetNonEmpty` was true.
   */
  start: (phrase: string) => void;
  /** Cancel any in-flight run; resets phase to closed. */
  cancel: () => void;
}

/**
 * Drive the Vollständiger-Import state machine.
 */
export function useImportAllRunner(input: UseImportAllRunnerInput): UseImportAllRunnerResult {
  const { isOpen } = input;
  const [phase, setPhase] = useState<DialogPhase>({ kind: 'closed' });
  const abortRef = useRef<AbortController | null>(null);

  // Parsed-zip bag populated by `pickFile` and consumed by `start`.
  // Holding the parsed bag (entries map + manifest + envelope) — not
  // the raw zip bytes — means the orchestrator never re-unzips at
  // commit time. At hundreds-of-MB takeout sizes this is the
  // difference between one peak inflation and two.
  const parsedRef = useRef<ParsedTakeoutZip | null>(null);

  // Reset on close.
  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort();
      abortRef.current = null;
      parsedRef.current = null;
      setPhase({ kind: 'closed' });
      return;
    }
    setPhase({ kind: 'awaiting-file' });
  }, [isOpen]);

  const cancel = useCallback(() => {
    // Fire-and-forget abort: signal the orchestrator and tear the
    // dialog state down immediately so the UI feels responsive. The
    // orchestrator's rollback walk (DELETE-each-committed-id) settles
    // in the background after this function returns — its
    // `Promise.allSettled` is detached from the runner once `signal`
    // fires.
    //
    // Edge case (accepted): if the user cancels mid-run on a target
    // that was non-empty pre-import and re-opens the dialog before
    // the rollback walk finishes, the `pickFile` dry-run may still
    // see committed rows from the cancelled run. The window closes
    // within the time it takes to DELETE each committed id (single
    // round-trip per id, so usually sub-second for a small batch).
    // Awaiting the rollback here would block the dialog close on a
    // network walk and trade a brittle UX for a correctness fix that
    // isn't structurally needed — the orphan reaper handles eventual
    // B2 cleanup either way (data-model.md §6.11).
    abortRef.current?.abort();
    abortRef.current = null;
    parsedRef.current = null;
    setPhase({ kind: 'closed' });
  }, []);

  const pickFile = useCallback(async (file: File) => {
    let bytes: Uint8Array;
    try {
      bytes = await readFileBytes(file);
    } catch (err) {
      console.warn('[import-all] file read failed', err);
      setPhase({
        kind: 'error',
        message: STRINGS.dataExchange.importAllError,
      });
      return;
    }

    // Parse + structurally validate ONCE. The bag is held in
    // `parsedRef` and threaded through `start` to the orchestrator so
    // the same bytes are never inflated twice — at hundreds-of-MB
    // takeout sizes that's a peak-memory halving.
    let bag: ParsedTakeoutZip;
    try {
      bag = parseTakeoutZip(bytes);
    } catch (err) {
      console.warn('[import-all] zip parse failed', err);
      setPhase({
        kind: 'error',
        message: STRINGS.dataExchange.importAllValidationFailed,
      });
      return;
    }

    if (bag.envelope.schema_version !== SCHEMA_VERSION) {
      setPhase({
        kind: 'error',
        message: STRINGS.errors.schemaVersionMismatch,
      });
      return;
    }

    const attachmentCount = (bag.envelope.attachments ?? []).length;
    const totalBytes = bag.manifest.files
      .filter((f) => f.attachmentId !== undefined)
      .reduce((sum, f) => sum + f.sizeBytes, 0);

    // Dry-run the importing instance to learn whether the target is
    // non-empty (drives the phrase prompt). The runner POSTs the
    // stripped envelope (no `attachments` key) — the same shape the
    // orchestrator's text leg sends — so the dry-run preview is
    // representative of the commit path.
    let preview: PreviewLite;
    try {
      const dryRun = await importAllApi.fetchDryRun(bag.envelope as never);
      if (!dryRun) {
        setPhase({
          kind: 'error',
          message: STRINGS.dataExchange.importAllError,
        });
        return;
      }
      preview = { targetNonEmpty: dryRun.target_non_empty === true };
    } catch (err) {
      console.warn('[import-all] dry-run failed', err);
      setPhase({
        kind: 'error',
        message: STRINGS.dataExchange.importAllError,
      });
      return;
    }

    parsedRef.current = bag;

    setPhase({
      kind: 'preflight',
      envelope: bag.envelope,
      attachmentCount,
      totalBytes,
      targetNonEmpty: preview.targetNonEmpty,
    });
  }, []);

  const start = useCallback((phrase: string) => {
    const bag = parsedRef.current;
    if (!bag) return;
    const envelope = bag.envelope;

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const totalCount = (envelope.attachments ?? []).length;
    // The preflight readout's totalBytes is what the dialog seeds;
    // re-read it from the latest preflight phase for the progress
    // hand-off.
    let totalSizeBytes = 0;
    setPhase((prev) => {
      if (prev.kind === 'preflight') {
        totalSizeBytes = prev.totalBytes;
      }
      return {
        kind: 'progress',
        totalCount,
        totalSizeBytes,
        filesDone: 0,
        bytesDone: 0,
        currentFile: '',
      };
    });

    let filesDone = 0;
    let bytesDone = 0;

    void (async () => {
      try {
        const result: ImportAllResult = await importAllFromZip({
          // Hot path — the parsed bag is reused verbatim. The
          // orchestrator skips its own `unzipSync` call and the
          // structural validators that `pickFile` already ran.
          parsed: bag,
          pinnedSchemaVersion: SCHEMA_VERSION,
          postTextLeg: async (envelopeWithoutAttachments: Omit<ImportEnvelope, 'attachments'>) =>
            importAllApi.postTextLeg(
              // The runner's local `ImportEnvelope` shape mirrors
              // `Envelope` minus the unused fields the adapter
              // doesn't read.
              envelopeWithoutAttachments as never,
              phrase,
            ),
          prepareAttachment,
          initAttachment,
          putCiphertext,
          completeAttachment: async (id: string) => {
            // Resolve the projectId from the entry list — the
            // orchestrator passes only the attachment id; the state
            // adapter requires both.
            const entry = (envelope.attachments ?? []).find((a) => a.id === id);
            if (!entry) {
              throw new Error(`completeAttachment: unknown attachment id ${id}`);
            }
            return importAllApi.importComplete(entry.projectId, id);
          },
          deleteAttachment: async (id: string) => {
            const entry = (envelope.attachments ?? []).find((a) => a.id === id);
            if (!entry) return;
            await importAllApi.importDelete(entry.projectId, id);
          },
          signal: ctrl.signal,
          onProgress: (event) => {
            if (event.kind === 'attachment-start') {
              setPhase((prev) => {
                if (prev.kind !== 'progress') return prev;
                return { ...prev, currentFile: event.entry.fileName };
              });
            } else if (event.kind === 'attachment-committed') {
              filesDone += 1;
              bytesDone += event.entry.sizeBytes;
              setPhase((prev) => {
                if (prev.kind !== 'progress') return prev;
                return { ...prev, filesDone, bytesDone };
              });
            } else if (event.kind === 'attachment-failed') {
              // Skipped entries still advance the file counter so the
              // user sees the run finish even when some entries
              // skipped.
              filesDone += 1;
              setPhase((prev) => {
                if (prev.kind !== 'progress') return prev;
                return { ...prev, filesDone };
              });
            }
          },
        });
        if (ctrl.signal.aborted) return;
        setPhase({
          kind: 'summary',
          committedCount: result.committedCount,
          totalAttachments: result.totalAttachments,
          failures: result.failures,
        });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        console.warn('[import-all] orchestrator failed', err);
        setPhase({
          kind: 'error',
          message:
            err instanceof Error
              ? `${STRINGS.dataExchange.importAllError} ${err.message}`
              : STRINGS.dataExchange.importAllError,
        });
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    })();
  }, []);

  return { phase, pickFile, start, cancel };
}
