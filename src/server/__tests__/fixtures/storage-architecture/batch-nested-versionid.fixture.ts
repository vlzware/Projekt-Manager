/**
 * Fixture: VersionId hidden inside the batch-delete shape
 * (`Delete.Objects[*].VersionId`). Asserts the AST detector walks the
 * argument expression recursively and flags a nested VersionId.
 */
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';

export const offending = new DeleteObjectsCommand({
  Bucket: 'bucket',
  Delete: {
    Objects: [
      { Key: 'a', VersionId: 'destroy-a' },
      { Key: 'b', VersionId: 'destroy-b' },
    ],
  },
});
