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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost as awsCreatePresignedPost } from '@aws-sdk/s3-presigned-post';
import type { Readable } from 'node:stream';
import { STORAGE_CONFIG } from '../config/index.js';

export interface StorageConfig {
  endpoint: string;
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
   * prefix, and size ceiling. See api.md §14.2.11 "Presigned-POST policy
   * conditions".
   */
  createPresignedPost?: (
    key: string,
    contentType: string,
    sizeBytes: number,
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
    sizeBytes: number,
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
}

const VALID_KEY_PATTERN = STORAGE_CONFIG.validKeyPattern;

/**
 * Validates a storage key to prevent path traversal and malformed keys.
 * Allowed: alphanumeric, `/`, `_`, `.`, `-`, length 1–1024.
 * Rejected: `..` sequences, leading `/` or `.`.
 */
export function validateKey(key: string): void {
  if (!key || !VALID_KEY_PATTERN.test(key)) {
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

export function createStorageClient(config: StorageConfig): AttachmentStorageClient {
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });

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
      return getSignedUrl(s3, command, { expiresIn: clamped });
    },

    async ping(): Promise<void> {
      // HeadBucket is cheap and authenticates, so a successful response
      // verifies endpoint, credentials, and bucket access in one shot.
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    },

    async createPresignedPost(
      key: string,
      contentType: string,
      sizeBytes: number,
      expirySeconds: number = 60,
    ): Promise<PresignedPostDescriptor> {
      validateKey(key);
      // Policy conditions — the load-bearing pins of AC-211:
      //  * exact key (no wildcards),
      //  * content-length-range upper bound = size ceiling,
      //  * content-type starts-with the requested MIME (the POST form
      //    echoes `Content-Type` verbatim, so the prefix match pins the
      //    exact type without tripping clients that also send a charset).
      const expiresIn = Math.max(1, expirySeconds);
      const result = await awsCreatePresignedPost(s3, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          { bucket },
          ['eq', '$key', key],
          ['content-length-range', 0, sizeBytes],
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
          ? {
              ResponseContentDisposition: `attachment; filename="${attachmentFileName.replace(/"/g, '')}"`,
            }
          : {}),
      });
      const url = await getSignedUrl(s3, command, { expiresIn: clamped });
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

    async listObjects(prefix: string, olderThan?: Date): Promise<string[]> {
      // No `validateKey` on `prefix` — a prefix is a substring match,
      // not a key. It still must stay in the allowed charset so a
      // caller cannot probe arbitrary bucket namespaces.
      if (!prefix || !/^[a-zA-Z0-9/_.-]{1,1024}$/.test(prefix)) {
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
