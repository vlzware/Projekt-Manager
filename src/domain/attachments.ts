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

export function classifyKind(mime: string): AttachmentKind {
  void mime;
  throw new Error('not implemented');
}

export function validateLabel(label: string): AttachmentLabel {
  void label;
  throw new Error('not implemented');
}

export function validateMime(mime: string): AttachmentMime {
  void mime;
  throw new Error('not implemented');
}
