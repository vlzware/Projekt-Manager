/**
 * Fixture pair (1 of 2): a local module re-exports the destructive SDK
 * command under a new name. The companion `reexport-consumer.fixture.ts`
 * imports it. The detector intentionally does NOT chase cross-file
 * re-exports — the corresponding test pins this as a documented gap.
 */
export { DeleteObjectCommand as Reexported } from '@aws-sdk/client-s3';
