/**
 * Bucket orphan prune — TS counterpart of `scripts/clean-bucket-orphans.sh`.
 *
 * Lists every current-version object in the configured bucket, intersects
 * with the keys still referenced by the `attachments` table (across every
 * status — `hidden` rows still hold a PUT version below their delete
 * marker that the un-hide flow promotes back), and writes a delete marker
 * (DeleteObject without VersionId) for the difference via the storage
 * client's `hide()` primitive.
 *
 * Wired into `start.ts` so `SEED=force` truly resets storage state along
 * with the DB. Without this, a forced re-seed truncates `attachments`
 * but leaves the bucket dirty — the orphan blobs are unreadable in
 * practice (per-row wrapped DEKs went away with the truncate), but they
 * still consume bucket space and would mirror real bytes onto B2's
 * Compliance-locked bucket via `scripts/sync-dev-to-vps.sh` if its
 * pollution guard didn't refuse.
 *
 * Versioning + Object Lock semantics: `storage.hide(key)` is DeleteObject
 * without a VersionId on a versioned bucket — only a delete marker is
 * written, the current version becomes noncurrent, and the underlying
 * bytes remain locked under the bucket's default Compliance retention
 * until R + L days pass and the lifecycle rule reaps them. The goal here
 * is a clean current view, not freed bytes.
 *
 * Bucket-listing dependency injection: the caller supplies the
 * `listAllBucketKeys` closure. Production wires it through
 * `createBucketKeyLister()` (paginated ListObjectsV2 against the
 * configured bucket); tests pass a stub returning a controlled set so a
 * test run cannot wipe the developer's working bucket — pruneBucketOrphans
 * is unbounded by design (it operates on the WHOLE bucket), and the
 * integration suite shares `STORAGE_BUCKET` with `npm run dev`.
 *
 * Safety: dev-only by construction — `start.ts` invokes this only when
 * `NODE_ENV !== 'production'` AND `SEED === 'force'`. The function
 * additionally refuses if `NODE_ENV === 'production'` (defense in
 * depth) so a misconfigured caller can never destroy production state.
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import type { AttachmentStorageClient } from './client.js';

export interface BucketKeyListerConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

export interface PruneBucketOrphansLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface PruneBucketOrphansResult {
  bucketObjectCount: number;
  preservedCount: number;
  orphanCount: number;
}

/**
 * Build the production lister: paginated ListObjectsV2 over the whole
 * bucket. Tests don't use this — they pass a stub that returns a
 * controlled set.
 */
export function createBucketKeyLister(config: BucketKeyListerConfig): () => Promise<string[]> {
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: true,
  });

  return async () => {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of response.Contents ?? []) {
        if (typeof obj.Key === 'string') keys.push(obj.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  };
}

export async function pruneBucketOrphans(
  db: Database,
  storage: AttachmentStorageClient,
  listAllBucketKeys: () => Promise<string[]>,
  logger: PruneBucketOrphansLogger,
  bucketLabel: string,
): Promise<PruneBucketOrphansResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'pruneBucketOrphans: refusing to run with NODE_ENV=production. ' +
        'This helper is dev-only — it issues delete-marker writes against the configured bucket.',
    );
  }

  // 1. Bucket listing — current-version view only.
  const bucketKeys = new Set<string>(await listAllBucketKeys());

  // 2. DB-referenced keys — every status (`pending`, `ready`, `hidden`).
  // `hidden` rows hold a legitimate PUT version below the delete marker
  // that the un-hide flow needs; preserving those keys here matches the
  // bash script's UNION.
  const referencedRows = await db.execute<{ key: string }>(sql`
    SELECT original_key AS key FROM attachments
    UNION
    SELECT thumb_key AS key FROM attachments WHERE thumb_key IS NOT NULL
  `);
  const referencedKeys = new Set<string>();
  for (const row of referencedRows.rows) {
    if (typeof row.key === 'string') referencedKeys.add(row.key);
  }

  // 3. Orphans = bucket - referenced.
  const orphans: string[] = [];
  for (const key of bucketKeys) {
    if (!referencedKeys.has(key)) orphans.push(key);
  }

  // 4. Hide each orphan via the storage wrapper's hide() primitive — same
  // call shape as the orphan reaper, idempotent on a versioned bucket.
  for (const key of orphans) {
    await storage.hide(key);
  }

  const result: PruneBucketOrphansResult = {
    bucketObjectCount: bucketKeys.size,
    preservedCount: bucketKeys.size - orphans.length,
    orphanCount: orphans.length,
  };

  if (orphans.length > 0) {
    logger.warn(
      `pruneBucketOrphans: hid ${orphans.length} orphan object(s) in bucket '${bucketLabel}' ` +
        `(preserved ${result.preservedCount} referenced, total ${result.bucketObjectCount}).`,
    );
  } else {
    logger.info(
      `pruneBucketOrphans: no orphans in bucket '${bucketLabel}' ` +
        `(${result.bucketObjectCount} object(s), all referenced).`,
    );
  }

  return result;
}
