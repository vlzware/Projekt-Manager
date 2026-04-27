/**
 * Fixture: the benign hide-marker shape. Mirrors
 * `src/server/storage/client.ts`'s `hide()` call. Asserts the detector
 * does NOT flag a `DeleteObjectCommand` without a VersionId — the
 * production sweep would fail on its own client otherwise.
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

export const benign = new DeleteObjectCommand({
  Bucket: 'bucket',
  Key: 'key',
  // no VersionId — this is a hide marker on a versioned bucket
});
