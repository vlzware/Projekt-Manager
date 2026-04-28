/**
 * Fixture: opaque-and-flag. The argument to `new DeleteObjectCommand`
 * is a function parameter — the detector cannot statically resolve it
 * to a literal in this file. Asserts the fail-closed branch: when the
 * argument shape is not a literal AND not a same-file `const`-bound
 * literal, the detector flags the call. A future contributor must
 * either inline the literal or arrange an exemption at the architecture
 * test boundary; silent pass is not an option.
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

export function dispatch(opts: { Bucket: string; Key: string }): DeleteObjectCommand {
  return new DeleteObjectCommand(opts);
}
