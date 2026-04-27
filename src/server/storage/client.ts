/**
 * S3-compatible object storage client.
 *
 * Wraps @aws-sdk/client-s3 with a minimal interface for upload, download,
 * delete, and signed URL generation. Configured with forcePathStyle for
 * MinIO compatibility.
 *
 * See architecture.md §11.4 for the module boundary definition.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost as awsCreatePresignedPost } from '@aws-sdk/s3-presigned-post';
import type { Readable } from 'node:stream';
import { STORAGE_CONFIG } from '../config/index.js';
import type { BucketSafetyConfig, LifecycleRuleSnapshot } from './safety.js';

export interface StorageConfig {
  endpoint: string;
  /**
   * Optional public endpoint used only when signing URLs returned to the
   * browser (presigned POST for init uploads, presigned GET for downloads
   * and bulk-zip pickup). When present, the signing client substitutes
   * this URL so the browser receives a host it can actually resolve —
   * typically a reverse-proxied subdomain (`https://storage.<domain>`)
   * that forwards to the internal MinIO endpoint. When absent, signing
   * reuses `endpoint` — correct for local dev where MinIO is exposed
   * on the host, wrong for any deployment where `endpoint` is a
   * container-only hostname.
   *
   * The signature's canonical request binds the host at signing time, so
   * the browser's request to the public URL verifies correctly against
   * MinIO behind the reverse proxy only when Caddy preserves the `Host`
   * header (Caddy's default).
   */
  publicEndpoint?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

export interface UploadResult {
  key: string;
}

export interface DownloadResult {
  data: Buffer | Uint8Array;
  contentType: string;
}

export interface HeadObjectResult {
  size: number;
  contentType: string;
}

export interface PresignedPostDescriptor {
  /** POST target URL. */
  url: string;
  /** Form fields the client must echo verbatim (includes signature). */
  fields: Record<string, string>;
  /** ISO 8601 — after this the descriptor is useless. */
  expiresAt: string;
}

export interface PresignedGetDescriptor {
  url: string;
  /** ISO 8601 — after this the URL is expired. */
  expiresAt: string;
}

/**
 * Thrown by `headObject` when the key is absent. Separate class so
 * callers can catch the "object missing" case cleanly without stringly
 * matching on the AWS SDK error shape.
 */
export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = 'StorageObjectNotFoundError';
  }
}

export interface StorageClient {
  upload(key: string, data: Buffer | Uint8Array, contentType: string): Promise<UploadResult>;
  download(key: string): Promise<DownloadResult>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expirySeconds: number): Promise<string>;
  /**
   * Liveness probe — verifies the configured bucket is reachable and
   * accessible with the current credentials. Used by the /api/health
   * endpoint (#48) so MinIO/S3 outages surface as "degraded" instead of
   * the old unconditional "ok" that masked real infrastructure problems.
   * Throws if the bucket is missing, credentials are wrong, or the
   * endpoint is unreachable.
   */
  ping(): Promise<void>;

  // ---------------------------------------------------------------
  // Attachment extensions (#108).
  //
  // Declared as optional so existing test mocks that only construct
  // the Tier-1 surface (upload / download / delete / getSignedUrl /
  // ping) still satisfy `as StorageClient`. The real factory
  // `createStorageClient()` always populates these — callers that
  // need them narrow via the `AttachmentStorageClient` alias below.
  // ---------------------------------------------------------------

  /**
   * Issue a presigned POST descriptor pinning the exact key, content type
   * prefix, and size range. See api.md §14.2.11 "Presigned-POST policy
   * conditions".
   *
   * `size.minBytes` / `size.maxBytes` map 1:1 to the S3
   * `content-length-range` policy. The main-upload call site pins
   * `minBytes === maxBytes` to the client's declared `sizeBytes` so a
   * size mismatch is rejected by storage before a complete() HEAD ever
   * runs. The thumbnail call site leaves the range liberal
   * (`[1, perFileCap]`) because the thumb's true size is not known at
   * init time.
   */
  createPresignedPost?: (
    key: string,
    contentType: string,
    size: { minBytes: number; maxBytes: number },
    expirySeconds?: number,
  ) => Promise<PresignedPostDescriptor>;

  /** Presigned GET URL + ISO-formatted expiry. */
  createPresignedGet?: (
    key: string,
    expirySeconds?: number,
    attachmentFileName?: string,
  ) => Promise<PresignedGetDescriptor>;

  /**
   * HEAD-check an object. Returns `{ size, contentType }` or throws
   * `StorageObjectNotFoundError` on a 404.
   */
  headObject?: (key: string) => Promise<HeadObjectResult>;

  /** Explicit delete. Same semantic as `delete`; distinct name so
   * attachment-flow call sites read naturally. */
  deleteObject?: (key: string) => Promise<void>;

  /**
   * Stream the raw bytes of an object. The returned Readable carries the
   * SDK's SdkStream mixin in practice, but the mixin is not part of the
   * contract — callers pipe or collect. Throws
   * `StorageObjectNotFoundError` on a 404 so the consumer can distinguish
   * "missing object" from a transport fault (same contract as
   * `headObject`).
   *
   * Used by the bulk-download zip assembly in `AttachmentService` (#108)
   * to source each entry's bytes for the archiver pipe.
   */
  getObject?: (key: string) => Promise<Readable>;

  /**
   * Upload bytes under a server-issued key. Streaming body is accepted
   * so the caller can pipe an archiver output straight into the upload
   * without buffering the full zip in memory when it grows to the
   * 20 MB bulk-download cap. Content length is passed explicitly because
   * the streaming-upload path needs it to set `Content-Length` up-front.
   */
  putObject?: (key: string, body: Buffer | Uint8Array, contentType: string) => Promise<void>;

  /**
   * List keys under the given prefix. `olderThan`, when supplied, filters
   * to objects whose LastModified is strictly older than the cutoff —
   * letting the bulk-download sweep reaper skip still-live temp zips
   * without needing a second round-trip per object.
   */
  listObjects?: (prefix: string, olderThan?: Date) => Promise<string[]>;

  /**
   * Boot-time bucket-safety probe (ADR-0022 / docs/ops/object-storage-provisioning.md).
   * Returns a structured snapshot of versioning + Object Lock + lifecycle
   * for `assertStorageBucketSafe()` in `./safety.ts` to evaluate.
   */
  getBucketSafetyConfig?: () => Promise<BucketSafetyConfig>;
}

/**
 * Narrowed surface used by the attachment subsystem — guarantees the
 * Tier-2 methods exist. `createStorageClient()` returns a fully-populated
 * client that satisfies this alias; attachment services accept this
 * narrower type so a `StorageClient` lacking the methods fails at tsc.
 */
export interface AttachmentStorageClient extends StorageClient {
  createPresignedPost: (
    key: string,
    contentType: string,
    size: { minBytes: number; maxBytes: number },
    expirySeconds?: number,
  ) => Promise<PresignedPostDescriptor>;
  createPresignedGet: (
    key: string,
    expirySeconds?: number,
    attachmentFileName?: string,
  ) => Promise<PresignedGetDescriptor>;
  headObject: (key: string) => Promise<HeadObjectResult>;
  deleteObject: (key: string) => Promise<void>;
  getObject: (key: string) => Promise<Readable>;
  putObject: (key: string, body: Buffer | Uint8Array, contentType: string) => Promise<void>;
  listObjects: (prefix: string, olderThan?: Date) => Promise<string[]>;
  getBucketSafetyConfig: () => Promise<BucketSafetyConfig>;
}

/**
 * Validates a storage key to prevent path traversal and malformed keys.
 * Charset + length rule lives on `STORAGE_CONFIG.validKeyPattern` (single
 * source of truth). Structural rules (no `..`, no leading `/` or `.`)
 * are enforced here because they're per-key shape, not a reusable regex.
 */
export function validateKey(key: string): void {
  if (!key || !STORAGE_CONFIG.validKeyPattern.test(key)) {
    throw new Error(
      `Invalid storage key: must be 1–1024 characters matching [a-zA-Z0-9/_.-]. Got: "${key}"`,
    );
  }
  if (key.includes('..')) {
    throw new Error(`Invalid storage key: path traversal ("..") is not allowed. Got: "${key}"`);
  }
  if (key.startsWith('/') || key.startsWith('.')) {
    throw new Error(`Invalid storage key: must not start with "/" or ".". Got: "${key}"`);
  }
}

export const MIN_SIGNED_URL_EXPIRY_SECONDS = STORAGE_CONFIG.minSignedUrlExpirySec;
export const MAX_SIGNED_URL_EXPIRY_SECONDS = STORAGE_CONFIG.maxSignedUrlExpirySec;

/**
 * Build a safe `Content-Disposition` value for a presigned GET download.
 *
 * RFC 6266 + RFC 5987: emit both an ASCII `filename="…"` fallback (for
 * ancient clients that ignore `filename*`) and a UTF-8 percent-encoded
 * `filename*=UTF-8''…` parameter (for modern browsers). The ASCII
 * fallback replaces any byte outside the printable-ASCII range — plus
 * control chars, backslash and double-quote — with `_` so header
 * injection is impossible and the quoted-string grammar of the header
 * is never broken.
 *
 * The server-side filename validator at the service boundary already
 * rejects control chars and path separators; this helper is the final
 * defence-in-depth layer that keeps the storage surface safe even if a
 * hostile filename were to slip past earlier validation.
 */
export function buildContentDisposition(fileName: string): string {
  // Stripping these control bytes is precisely the sanitizer's job;
  // without them the ASCII-fallback path would allow header injection
  // via a CR/LF smuggled into the Content-Disposition string.
  // eslint-disable-next-line no-control-regex
  const STRIP_TO_UNDERSCORE = /[\x00-\x1f\x7f"\\]/g;
  const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;
  const asciiFallback = fileName
    .replace(STRIP_TO_UNDERSCORE, '_')
    .replace(NON_PRINTABLE_ASCII, '_');
  const utf8Encoded = encodeURIComponent(fileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Collapse the SDK's LifecycleRule into the structured snapshot the
 * safety validator consumes. Filter shape can be `{Prefix}`, `{Tag}`, or
 * `{And: {Prefix?, Tags?}}` — flatten into `(prefix, hasTagFilter)`.
 * Disallowed actions are anything beyond the canonical
 * `NoncurrentVersionExpiration + ExpiredObjectDeleteMarker` pair.
 */
function toLifecycleRuleSnapshot(rule: LifecycleRule): LifecycleRuleSnapshot {
  let prefix = '';
  let hasTagFilter = false;
  if (rule.Filter) {
    if (rule.Filter.Prefix !== undefined) prefix = rule.Filter.Prefix;
    if (rule.Filter.Tag) hasTagFilter = true;
    if (rule.Filter.And) {
      if (rule.Filter.And.Prefix !== undefined) prefix = rule.Filter.And.Prefix;
      if ((rule.Filter.And.Tags?.length ?? 0) > 0) hasTagFilter = true;
    }
  } else if (rule.Prefix !== undefined) {
    // Legacy non-Filter Prefix shape — pre-2018 S3 API. Still valid.
    prefix = rule.Prefix;
  }

  const expiration = rule.Expiration;
  const expireDeleteMarker = expiration?.ExpiredObjectDeleteMarker === true;

  // `Expiration.Days = 0` is the encoding S3 uses when only
  // `ExpiredObjectDeleteMarker` is set — treat as absent.
  const hasExpirationDays = (expiration?.Days ?? 0) > 0;
  const hasDisallowedActions =
    hasExpirationDays ||
    expiration?.Date !== undefined ||
    (rule.Transitions?.length ?? 0) > 0 ||
    (rule.NoncurrentVersionTransitions?.length ?? 0) > 0 ||
    rule.AbortIncompleteMultipartUpload !== undefined;

  return {
    id: rule.ID,
    status: rule.Status ?? 'Disabled',
    prefix,
    hasTagFilter,
    noncurrentDays: rule.NoncurrentVersionExpiration?.NoncurrentDays,
    expireDeleteMarker,
    hasDisallowedActions,
  };
}

export function createStorageClient(config: StorageConfig): AttachmentStorageClient {
  // Two clients on purpose:
  //   - `s3` (internal endpoint) — used for every operation whose HTTP
  //     request actually leaves this process: put/get/head/list/delete.
  //   - `s3Signing` (public endpoint) — used only by the presigning helpers,
  //     which compute the URL locally without making a network call. The
  //     URL is returned to the browser and must carry a host the browser
  //     can reach. In dev both endpoints collapse to the same host (MinIO
  //     exposed on localhost); in prod `publicEndpoint` is the
  //     reverse-proxied subdomain.
  // Collapsing into one client when `publicEndpoint` is absent is
  // intentional — keeps the code path identical for single-endpoint
  // deployments and keeps existing tests passing unchanged.
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
  const s3Signing = config.publicEndpoint
    ? new S3Client({
        endpoint: config.publicEndpoint,
        region: config.region ?? 'us-east-1',
        credentials: {
          accessKeyId: config.accessKey,
          secretAccessKey: config.secretKey,
        },
        forcePathStyle: true,
      })
    : s3;

  const bucket = config.bucket;

  return {
    async upload(
      key: string,
      data: Buffer | Uint8Array,
      contentType: string,
    ): Promise<UploadResult> {
      validateKey(key);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      );
      return { key };
    },

    async download(key: string): Promise<DownloadResult> {
      validateKey(key);
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );

      const stream = response.Body;
      if (!stream) {
        throw new Error(`Empty response body for key: ${key}`);
      }

      // The SDK returns a readable stream (or Blob in browser).
      // In Node.js, Body has a transformToByteArray() helper.
      const bytes = await stream.transformToByteArray();
      const data = Buffer.from(bytes);

      return {
        data,
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    },

    async delete(key: string): Promise<void> {
      validateKey(key);
      // S3 DeleteObject is idempotent — does not throw for missing keys.
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    },

    async getSignedUrl(key: string, expirySeconds: number): Promise<string> {
      validateKey(key);
      if (expirySeconds < MIN_SIGNED_URL_EXPIRY_SECONDS) {
        throw new Error(
          `expirySeconds must be at least ${MIN_SIGNED_URL_EXPIRY_SECONDS}. Got: ${expirySeconds}`,
        );
      }
      const clamped = Math.min(expirySeconds, MAX_SIGNED_URL_EXPIRY_SECONDS);
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      return getSignedUrl(s3Signing, command, { expiresIn: clamped });
    },

    async ping(): Promise<void> {
      // HeadBucket is cheap and authenticates, so a successful response
      // verifies endpoint, credentials, and bucket access in one shot.
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    },

    async createPresignedPost(
      key: string,
      contentType: string,
      size: { minBytes: number; maxBytes: number },
      expirySeconds: number = 60,
    ): Promise<PresignedPostDescriptor> {
      validateKey(key);
      // Policy conditions — the load-bearing pins of AC-211:
      //  * exact key (no wildcards),
      //  * content-length-range [minBytes, maxBytes] — the main-upload
      //    path pins min === max to the declared size so storage
      //    rejects any deviation (size-substitution upload attack). The
      //    thumbnail path supplies a liberal [1, cap] range because the
      //    thumb's true size is not known at init time.
      //  * content-type starts-with the requested MIME (the POST form
      //    echoes `Content-Type` verbatim, so the prefix match pins the
      //    exact type without tripping clients that also send a charset).
      if (!Number.isInteger(size.minBytes) || size.minBytes < 0) {
        throw new Error(
          `createPresignedPost: size.minBytes must be a non-negative integer, got ${size.minBytes}`,
        );
      }
      if (!Number.isInteger(size.maxBytes) || size.maxBytes < size.minBytes) {
        throw new Error(
          `createPresignedPost: size.maxBytes must be an integer >= minBytes, got ${size.maxBytes}`,
        );
      }
      const expiresIn = Math.max(1, expirySeconds);
      const result = await awsCreatePresignedPost(s3Signing, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          { bucket },
          ['eq', '$key', key],
          ['content-length-range', size.minBytes, size.maxBytes],
          ['starts-with', '$Content-Type', contentType],
        ],
        Fields: {
          'Content-Type': contentType,
        },
        Expires: expiresIn,
      });
      return {
        url: result.url,
        fields: result.fields,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    },

    async createPresignedGet(
      key: string,
      expirySeconds: number = 5 * 60,
      attachmentFileName?: string,
    ): Promise<PresignedGetDescriptor> {
      validateKey(key);
      if (expirySeconds < MIN_SIGNED_URL_EXPIRY_SECONDS) {
        throw new Error(
          `expirySeconds must be at least ${MIN_SIGNED_URL_EXPIRY_SECONDS}. Got: ${expirySeconds}`,
        );
      }
      const clamped = Math.min(expirySeconds, MAX_SIGNED_URL_EXPIRY_SECONDS);
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(attachmentFileName
          ? { ResponseContentDisposition: buildContentDisposition(attachmentFileName) }
          : {}),
      });
      const url = await getSignedUrl(s3Signing, command, { expiresIn: clamped });
      return {
        url,
        expiresAt: new Date(Date.now() + clamped * 1000).toISOString(),
      };
    },

    async headObject(key: string): Promise<HeadObjectResult> {
      validateKey(key);
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: Number(res.ContentLength ?? 0),
          contentType: res.ContentType ?? 'application/octet-stream',
        };
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
          throw new StorageObjectNotFoundError(key);
        }
        throw err;
      }
    },

    async deleteObject(key: string): Promise<void> {
      validateKey(key);
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async getObject(key: string): Promise<Readable> {
      validateKey(key);
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = response.Body;
        if (!body) {
          throw new Error(`Empty response body for key: ${key}`);
        }
        // In Node.js, the SDK returns a Readable (IncomingMessage). The
        // SdkStream mixin exposes `transformTo*` helpers, but we want the
        // raw stream so archiver can pipe it. Narrow to `Readable` — the
        // browser branch of `StreamingBlobPayloadOutputTypes` never
        // surfaces on the server.
        return body as unknown as Readable;
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (
          e.name === 'NoSuchKey' ||
          e.name === 'NotFound' ||
          e.$metadata?.httpStatusCode === 404
        ) {
          throw new StorageObjectNotFoundError(key);
        }
        throw err;
      }
    },

    async putObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
      validateKey(key);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async getBucketSafetyConfig(): Promise<BucketSafetyConfig> {
      // Three independent reads — versioning, object-lock, lifecycle.
      // Each can succeed/fail independently; the validator handles the
      // "feature not enabled" cases as semantic absence (versioningEnabled=
      // false, objectLock.enabled=false, lifecycleRules=[]).
      const ver = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      const versioningEnabled = ver.Status === 'Enabled';

      let objectLock: BucketSafetyConfig['objectLock'] = { enabled: false };
      try {
        const ol = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
        if (ol.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled') {
          objectLock = {
            enabled: true,
            defaultMode: ol.ObjectLockConfiguration.Rule?.DefaultRetention?.Mode,
            defaultDays: ol.ObjectLockConfiguration.Rule?.DefaultRetention?.Days,
          };
        }
      } catch (err) {
        const e = err as { name?: string };
        // ObjectLockConfigurationNotFoundError when the bucket was
        // created without --with-lock. Fall through to enabled:false so
        // the validator surfaces a structured failure instead of an
        // opaque SDK error.
        if (e.name !== 'ObjectLockConfigurationNotFoundError') throw err;
      }

      let lifecycleRules: BucketSafetyConfig['lifecycleRules'] = [];
      try {
        const lc = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
        lifecycleRules = (lc.Rules ?? []).map(toLifecycleRuleSnapshot);
      } catch (err) {
        const e = err as { name?: string };
        // NoSuchLifecycleConfiguration when no rules — semantic absence.
        if (e.name !== 'NoSuchLifecycleConfiguration') throw err;
      }

      return { versioningEnabled, objectLock, lifecycleRules };
    },

    async listObjects(prefix: string, olderThan?: Date): Promise<string[]> {
      // No `validateKey` on `prefix` — a prefix is a substring match,
      // not a key. It still must stay in the allowed charset so a
      // caller cannot probe arbitrary bucket namespaces. Reuses the
      // same pattern as keys (single source of truth in STORAGE_CONFIG).
      if (!prefix || !STORAGE_CONFIG.validKeyPattern.test(prefix)) {
        throw new Error(`Invalid listObjects prefix: "${prefix}"`);
      }
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of response.Contents ?? []) {
          const k = obj.Key;
          if (typeof k !== 'string') continue;
          if (olderThan && obj.LastModified && obj.LastModified >= olderThan) continue;
          keys.push(k);
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
  };
}
