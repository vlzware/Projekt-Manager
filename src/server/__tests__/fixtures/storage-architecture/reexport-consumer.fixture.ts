/**
 * Fixture pair (2 of 2): consumes the local re-export from
 * `reexport-source.fixture.ts`. The detector cannot resolve `Reexported`
 * back to `@aws-sdk/client-s3` without a full TypeChecker program — the
 * paired test pins this as a known residual gap. The capability split
 * (issue #45 primary defense) refuses the call at the wire regardless.
 */
import { Reexported } from './reexport-source.fixture.js';

export const undetected = new Reexported({
  Bucket: 'bucket',
  Key: 'key',
  VersionId: 'destroy',
});
