/**
 * Fixture: namespace import bypassing a regex-text scanner.
 * Asserts the AST detector recognizes `S3.DeleteObjectCommand` as
 * the destructive constructor and flags the VersionId.
 */
import * as S3 from '@aws-sdk/client-s3';

export const offending = new S3.DeleteObjectCommand({
  Bucket: 'bucket',
  Key: 'key',
  VersionId: 'destroy',
});
