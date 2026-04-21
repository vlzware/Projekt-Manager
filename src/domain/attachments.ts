/**
 * Attachment domain helpers — closed catalogs + validators.
 *
 * The label enum and MIME whitelist are pinned by data-model.md §5.13
 * and architecture.md §12.2 (`[C]` catalog). Server and client share
 * these so rejected inputs surface the same German message regardless
 * of which layer catches them first.
 */

import type { AttachmentKind, AttachmentLabel } from './types.js';

export const ATTACHMENT_LABELS: ReadonlyArray<{
  readonly value: AttachmentLabel;
  readonly label: string;
}> = [
  { value: 'angebot', label: 'Angebot' },
  { value: 'auftragsbestaetigung', label: 'Auftragsbestätigung' },
  { value: 'rechnung', label: 'Rechnung' },
  { value: 'aufmass', label: 'Aufmaß' },
  { value: 'foto', label: 'Foto' },
  { value: 'sonstiges', label: 'Sonstiges' },
] as const;

export const ATTACHMENT_MIME_WHITELIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export type AttachmentMime = (typeof ATTACHMENT_MIME_WHITELIST)[number];

const PHOTO_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);

const LABEL_VALUES: ReadonlySet<string> = new Set(ATTACHMENT_LABELS.map((entry) => entry.value));

const MIME_WHITELIST_SET: ReadonlySet<string> = new Set(ATTACHMENT_MIME_WHITELIST);

/**
 * Classification of a whitelisted MIME into the photo/binary bucket used
 * by the gallery and the thumbnail flow (data-model.md §5.13). Callers
 * must have validated the MIME first via `validateMime`; passing an
 * unknown MIME throws so a contract violation fails loudly at the call
 * site rather than landing as a mislabeled row in the DB.
 */
export function classifyKind(mime: string): AttachmentKind {
  if (!MIME_WHITELIST_SET.has(mime)) {
    throw new Error(`classifyKind: MIME '${mime}' is not in the whitelist`);
  }
  return PHOTO_MIMES.has(mime) ? 'photo' : 'binary';
}

/**
 * Accept-or-throw guard for `AttachmentLabel` (closed enum). Throws a
 * plain Error — service/route layers catch and translate to a 422. The
 * helper is used both server-side (route validation) and client-side
 * (pre-upload UX gate).
 */
export function validateLabel(label: string): AttachmentLabel {
  if (!LABEL_VALUES.has(label)) {
    throw new Error(`validateLabel: '${label}' is not a valid AttachmentLabel`);
  }
  return label as AttachmentLabel;
}

/**
 * Accept-or-throw guard for the MIME whitelist. IANA MIME types are
 * lowercase — rejecting case variants keeps client and server aligned.
 */
export function validateMime(mime: string): AttachmentMime {
  if (!MIME_WHITELIST_SET.has(mime)) {
    throw new Error(`validateMime: '${mime}' is not in the whitelist`);
  }
  return mime as AttachmentMime;
}

/**
 * Client-side rule for showing the delete affordance on a row. Mirrors
 * the server-side check (AC-215): owner + office can delete any
 * attachment; a worker only if they authored it AND the grace window has
 * not expired; bookkeeper never. The server stays authoritative — this
 * is UX gating per the hidden-control pattern (AC-121).
 */
export function canDeleteAttachment(
  row: { createdBy: string | null; createdAt: string },
  caller: { id: string; roles: string[] },
  graceWindowMinutes: number,
  now: Date = new Date(),
): boolean {
  if (caller.roles.includes('owner') || caller.roles.includes('office')) return true;
  if (caller.roles.includes('worker')) {
    if (row.createdBy !== caller.id) return false;
    const ageMs = now.getTime() - new Date(row.createdAt).getTime();
    return ageMs <= graceWindowMinutes * 60_000;
  }
  return false;
}
