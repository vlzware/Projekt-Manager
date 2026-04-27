/**
 * Fixture: object-literal `...spread`. Without a TypeChecker the detector
 * cannot see what the spread source contributes, and a spread can carry
 * `VersionId`. Asserts the fail-closed branch: an inline object literal
 * containing any `...spread` whose source is not a same-file resolvable
 * literal must be flagged. Silent pass would re-open the bypass via
 * "build the destructive shape outside, splat it in".
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

const opts = { Bucket: 'bucket', Key: 'key', VersionId: 'destroy' };

export const offending = new DeleteObjectCommand({ ...opts });
