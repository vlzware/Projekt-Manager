/**
 * Fixture: variable-bound destructive argument. The shape that previously
 * evaded the inline-only detector at `client.ts:probeDeleteVersionCapability`
 * (T5c) — assert the AST detector now resolves a single hop of intra-file
 * `const` binding for the `new`-expression argument and flags the VersionId
 * carried by the resolved literal.
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

const probeInput = {
  Bucket: 'bucket',
  Key: 'key',
  VersionId: 'destroy',
};

export const offending = new DeleteObjectCommand(probeInput);
