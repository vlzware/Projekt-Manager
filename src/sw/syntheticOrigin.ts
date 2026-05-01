/**
 * Synthetic-origin URL builder for the Service-Worker decrypt path
 * (ADR-0024 / spec ui/project-detail.md §8.15.4 + §8.15.5 + §8.15.7).
 *
 * The SW intercepts `/encrypted-storage/<projectId>/<attachmentId>.<variant>`
 * requests, calls `download-url`, fetches the ciphertext from object
 * storage, AES-GCM-decrypts, and returns plaintext bytes through the
 * Fetch response. SPA consumers (`<img src>`, `<iframe src>`,
 * `<a href download>`) point at the URL this helper builds and treat
 * it as opaque — the bytes the browser sees are plaintext.
 *
 * Centralised so the path scheme has one definition. A schema change
 * (SW route, variant naming) lands here and propagates through every
 * caller.
 */

export type AttachmentVariant = 'original' | 'thumbnail';

export function synthAttachmentUrl(
  projectId: string,
  attachmentId: string,
  variant: AttachmentVariant,
): string {
  return `/encrypted-storage/${projectId}/${attachmentId}.${variant}`;
}
