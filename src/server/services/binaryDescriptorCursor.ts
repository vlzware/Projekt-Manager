/**
 * Opaque cursor codec for `BinaryDescriptorService.listPage` (api.md
 * §14.2.4 / AC-248). Format: base64 of
 * `<iso>|<uuid>|<totalCount>|<totalSizeBytes>` (4 parts; halves are
 * `|`-free by their own grammars). Iteration-pinned totals ride the
 * cursor verbatim so they survive every subsequent page within one
 * drain — the spec's stability invariant.
 *
 * Pure module: no DB, no IO, no closure state. The `Number.isSafeInteger`
 * guard mirrors the producer-side assertion in `BinaryDescriptorService`
 * so the consumer cannot quietly accept what the producer would have
 * rejected.
 */

import { validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';

/**
 * Decoded shape carried in the cursor. Iteration-pinned totals stay
 * sticky across all pages within one drain (api.md §14.2.4).
 */
export interface BinaryDescriptorCursor {
  createdAt: Date;
  id: string;
  totalCount: number;
  totalSizeBytes: number;
}

/**
 * UUID v4 shape — case-insensitive, same as the schema validator. A
 * non-UUID id half is a forgery; surface as VALIDATION_ERROR rather
 * than fail at the SQL layer.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Non-negative decimal integer (no leading zeros except the literal
 * `0`, no signs, no non-digit chars). Strictness keeps two distinct
 * cursor strings from encoding the same iteration.
 */
const NON_NEGATIVE_INT_REGEX = /^(0|[1-9][0-9]*)$/;

/**
 * Decode the opaque `after` token. Reject anything malformed with
 * `422 VALIDATION_ERROR`.
 */
export function decodeCursor(raw: string): BinaryDescriptorCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    throw validationError(STRINGS.errors.invalidInput);
  }
  // Round-trip check — anything that didn't survive base64 cleanly is a
  // forgery (Buffer.from silently drops non-base64 bytes; the encode-back
  // mismatch is the canonical detector).
  if (Buffer.from(decoded, 'utf-8').toString('base64') !== raw) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const parts = decoded.split('|');
  if (parts.length !== 4) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const [iso, id, totalCountRaw, totalSizeBytesRaw] = parts as [string, string, string, string];
  // Date.parse accepts plenty of garbage ("not-a-real-cursor" included
  // when base64-decoded happens to roundtrip). Pin the shape to ISO 8601
  // by re-serialising and comparing — the cursors we issue all use
  // `Date.toISOString()`, so the round-trip is exact.
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const createdAt = new Date(ts);
  if (createdAt.toISOString() !== iso) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  if (!UUID_V4_REGEX.test(id)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  if (
    !NON_NEGATIVE_INT_REGEX.test(totalCountRaw) ||
    !NON_NEGATIVE_INT_REGEX.test(totalSizeBytesRaw)
  ) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const totalCount = Number(totalCountRaw);
  const totalSizeBytes = Number(totalSizeBytesRaw);
  if (!Number.isSafeInteger(totalCount) || !Number.isSafeInteger(totalSizeBytes)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  return { createdAt, id, totalCount, totalSizeBytes };
}

export function encodeCursor(
  createdAt: Date,
  id: string,
  totalCount: number,
  totalSizeBytes: number,
): string {
  return Buffer.from(
    `${createdAt.toISOString()}|${id}|${totalCount}|${totalSizeBytes}`,
    'utf-8',
  ).toString('base64');
}
