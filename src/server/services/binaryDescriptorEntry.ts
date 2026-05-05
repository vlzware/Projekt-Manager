/**
 * Per-row composer for `BinaryDescriptorService.listPage` (api.md
 * §14.2.4 / AC-248). Validates the envelope-format discriminator,
 * unwraps the per-row DEK, and signs the presigned-GET. A
 * `KeyEnvelopeUnwrapError` (per-row corruption, recipient mismatch,
 * format gate refusal) collapses to the inline
 * `error='DEK_UNWRAP_FAILED'` shape per AC-248. Any other failure
 * (missing operator identity, `age` binary absent) is a wholesale
 * fault — propagate as 5xx via `serverError()`.
 *
 * Pure: depends only on its explicit arguments (no closure capture
 * over the surrounding service).
 */
import { isKnownWrappedDekVersion } from '../../domain/attachments.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { KeyEnvelopeService, KeyEnvelopeUnwrapError } from './KeyEnvelopeService.js';
import { serverError } from '../errors.js';
import type { BinaryDescriptor } from './BinaryDescriptorService.js';

/**
 * Row shape consumed by `composeEntry` — projection over `attachments`
 * joined with `projects` that the page query selects. Pinned here so
 * the page query and the composer share one ground truth for the row
 * contract.
 */
export interface BinaryDescriptorRow {
  id: string;
  projectId: string;
  projectNumber: string;
  projectTitle: string;
  filename: string;
  sizeBytes: number;
  originalKey: string;
  wrappedDek: string | null;
  wrappedDekVersion: number;
  createdAt: Date;
}

export async function composeEntry(
  envelope: KeyEnvelopeService,
  storage: AttachmentStorageClient,
  row: BinaryDescriptorRow,
): Promise<BinaryDescriptor> {
  const base = {
    attachmentId: row.id,
    projectId: row.projectId,
    projectNumber: row.projectNumber,
    projectTitle: row.projectTitle,
    fileName: row.filename,
    sizeBytes: row.sizeBytes,
  };

  // Format-version gate (ADR-0024). A row on an unknown wrapping
  // format collapses to the per-row error tag — same shape as
  // corrupted bytes. The download-url path uses the same gate.
  if (!isKnownWrappedDekVersion(row.wrappedDekVersion) || !row.wrappedDek) {
    return { ...base, error: 'DEK_UNWRAP_FAILED' };
  }

  let dekBytes: Uint8Array;
  try {
    dekBytes = await envelope.unwrap(Buffer.from(row.wrappedDek, 'base64'));
  } catch (err) {
    if (err instanceof KeyEnvelopeUnwrapError) {
      // Per-row corruption / recipient mismatch — surface inline.
      return { ...base, error: 'DEK_UNWRAP_FAILED' };
    }
    // Wholesale failure (operator-side condition) — escalate.
    throw serverError();
  }

  // Sign the presigned GET against the storage public endpoint. The
  // download triggers a Content-Disposition with the plaintext file
  // name (mirrors `AttachmentService.issueDownloadUrl`), so the
  // browser saves the ciphertext under a recognisable name even
  // before client-side decrypt.
  const presigned = await storage.createPresignedGet(row.originalKey, undefined, row.filename);

  return {
    ...base,
    originalUrl: presigned.url,
    originalDekMaterial: Buffer.from(dekBytes).toString('base64'),
    expiresAt: presigned.expiresAt,
  };
}
