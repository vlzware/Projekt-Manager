/**
 * Fixture: intra-file rebinding bypassing a regex-text scanner.
 * Asserts the AST detector chases `const X = DeleteObjectCommand`
 * back to the SDK origin and flags the VersionId on `new X(...)`.
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

const X = DeleteObjectCommand;

export const offending = new X({
  Bucket: 'bucket',
  Key: 'key',
  VersionId: 'destroy',
});
