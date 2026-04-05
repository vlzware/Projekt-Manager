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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

export interface StorageClient {
  upload(key: string, data: Buffer | Uint8Array, contentType: string): Promise<UploadResult>;
  download(key: string): Promise<DownloadResult>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expirySeconds: number): Promise<string>;
}

const VALID_KEY_PATTERN = /^[a-zA-Z0-9/_.-]{1,1024}$/;

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

export const MIN_SIGNED_URL_EXPIRY_SECONDS = 1;
export const MAX_SIGNED_URL_EXPIRY_SECONDS = 3600;

export function createStorageClient(config: StorageConfig): StorageClient {
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
  };
}
