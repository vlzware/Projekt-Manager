// Authenticated R2 reachability probe for the backup container entrypoint.
//
// Runs once on container start (after scripts/backup/entrypoint.sh has
// validated env presence) and before crond is exec'd. A stale
// AKID/Secret pair, a bucket-scope typo, or a dead R2 endpoint would
// otherwise only surface at the next scheduled tick — up to a full
// cycle of lost MTTR after a credential rotation, and the freshness
// badge goes stale only after the first missed cycle. Failing fast
// here collapses the debug loop to the deploy itself: deploy.sh waits
// for the container to reach a running state, so a probe failure
// surfaces as a visibly-failed deploy instead of a silent amber badge
// an hour later.
//
// HeadBucket is the cheapest authenticated S3 call — same one
// src/server/storage/client.ts uses for MinIO in the app's /api/health.
// The S3Client config here mirrors src/server/services/r2Uploader.ts
// (path-style, region falls back to 'auto') so a probe success implies
// the real uploader path will authenticate too.
//
// Error reporting is deliberately minimal: error.name + message only.
// Secrets never hit stdout/stderr — SDK errors at this layer don't
// echo credentials, but keeping the log shape narrow closes that door.

import { createRequire } from 'node:module';

// Resolve @aws-sdk/client-s3 from the bundled app node_modules. The
// probe script lives in /usr/local/bin (next to run-backup.sh), not
// under /app, so a plain bare import would miss /app/node_modules on
// upward lookup. createRequire anchored at /app/ reproduces the exact
// resolution the real backup-runner gets.
const require = createRequire('/app/');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

const required = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`probe-r2: missing env: ${missing.join(' ')}`);
  process.exit(1);
}

const client = new S3Client({
  endpoint: process.env.R2_ENDPOINT,
  region: process.env.R2_REGION || 'auto',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

try {
  await client.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET }));
  console.log(`probe-r2: HeadBucket OK bucket=${process.env.R2_BUCKET}`);
} catch (err) {
  // HeadBucket returns no XML body, so the SDK often maps auth failures
  // to `Unknown` / `UnknownError`. Include the HTTP status and the raw
  // status code so 403 (auth: bad secret, dead token, wrong bucket
  // scope) vs 404 (bucket missing) vs 5xx (R2 outage) is obvious
  // without cross-referencing the SDK internals.
  const name = err?.name ?? 'Error';
  const message = typeof err?.message === 'string' ? err.message : String(err);
  const status = err?.$metadata?.httpStatusCode ?? 'unknown';
  console.error(`probe-r2: HeadBucket failed: ${name}: ${message} (http=${status})`);
  process.exit(1);
}
