/**
 * Shared init-payload fixtures for attachment route + service tests.
 *
 * Every `POST /api/projects/:id/attachments/init` payload must carry an
 * RFC 1864 base64 MD5 (`contentMd5`); when `hasThumbnail = true`, the
 * payload also carries `thumbSizeBytes` + `thumbContentMd5`. These
 * helpers keep the boilerplate out of individual tests so a future
 * field added to the init contract changes one file, not thirty.
 *
 * Tests that exercise upload-time integrity supply the *actual* MD5 of
 * the body bytes; tests that exercise the route/service layer in
 * isolation use `STUB_MD5_BASE64` (MD5 of the empty string), which is a
 * valid RFC 1864 base64 value and passes both schema and service checks
 * without requiring per-test crypto.
 */

/** MD5 of the empty string, RFC 1864 base64. Schema-valid placeholder. */
export const STUB_MD5_BASE64 = '1B2M2Y8AsgTpgAmY7PhCfg==';

export interface InitOverrides {
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  contentMd5?: string;
  label?: string;
  hasThumbnail?: boolean;
  thumbSizeBytes?: number;
  thumbContentMd5?: string;
}

/**
 * Build a photo init payload (image MIME, `foto` label, thumbnail by
 * default). Override any field via `overrides`.
 */
export function photoInitBody(overrides: InitOverrides = {}): Record<string, unknown> {
  const hasThumbnail = overrides.hasThumbnail ?? true;
  return {
    fileName: overrides.fileName ?? 'photo.jpg',
    mimeType: overrides.mimeType ?? 'image/jpeg',
    sizeBytes: overrides.sizeBytes ?? 120_000,
    contentMd5: overrides.contentMd5 ?? STUB_MD5_BASE64,
    label: overrides.label ?? 'foto',
    hasThumbnail,
    ...(hasThumbnail
      ? {
          thumbSizeBytes: overrides.thumbSizeBytes ?? 8_000,
          thumbContentMd5: overrides.thumbContentMd5 ?? STUB_MD5_BASE64,
        }
      : {}),
  };
}

/**
 * Build a binary init payload (PDF, `rechnung` label, no thumbnail by
 * default). Override any field via `overrides`.
 */
export function binaryInitBody(overrides: InitOverrides = {}): Record<string, unknown> {
  return {
    fileName: overrides.fileName ?? 'doc.pdf',
    mimeType: overrides.mimeType ?? 'application/pdf',
    sizeBytes: overrides.sizeBytes ?? 50_000,
    contentMd5: overrides.contentMd5 ?? STUB_MD5_BASE64,
    label: overrides.label ?? 'rechnung',
    hasThumbnail: overrides.hasThumbnail ?? false,
  };
}
