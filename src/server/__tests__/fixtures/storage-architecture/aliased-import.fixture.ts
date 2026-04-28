/**
 * Fixture: aliased named import bypassing a regex-text scanner.
 * Asserts the AST detector resolves `Foo` back to
 * `@aws-sdk/client-s3`.DeleteObjectCommand and flags the VersionId.
 */
import { DeleteObjectCommand as Foo } from '@aws-sdk/client-s3';

export const offending = new Foo({
  Bucket: 'bucket',
  Key: 'key',
  VersionId: 'destroy',
});
