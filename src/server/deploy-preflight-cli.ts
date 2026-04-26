/**
 * Deploy pre-flight entry point. Invoked by `scripts/deploy.sh` INSIDE a
 * one-shot `docker run --rm` against the just-pulled deploy image. The
 * bundled output ships at `dist/server/deploy-preflight-cli.js` (esbuild
 * target list in `package.json` > `build:server`); the host-side
 * `deploy.sh` does not need any project node_modules — it only needs
 * Docker.
 *
 * Two checkpoints, one container start:
 *   1. `validateEnvAggregated()` — schema + every cross-field guard in
 *      one pass. Aborts the deploy on first failure (issue #139,
 *      AC-231).
 *   2. `formatFeatureManifest()` — the same per-feature manifest the
 *      app emits at boot (`event = 'config-feature-manifest'`),
 *      formatted for the operator's terminal so the operator sees what
 *      will be enabled / disabled BEFORE `docker compose up` recreates
 *      containers (AC-230 — the boot-time emission still lands in the
 *      app's stdout for log aggregation; this is the deploy-time
 *      mirror).
 *
 * Why a dedicated entry:
 *   - The existing `start.ts` entry point validates AND boots Fastify,
 *     opens DB pool, runs migrations — running it with the `up`-side
 *     effects to JUST check env would double-bind the port and race the
 *     eventual `docker compose up`. A dedicated CLI runs the checks
 *     only and exits.
 *   - Bundling keeps the "shells out to validateEnvAggregated +
 *     formatFeatureManifest" contract stable across schema refactors.
 *     The host-side script doesn't need to track esbuild's
 *     chunk-emission decisions.
 *
 * Aborts the deploy on first failure: prints the aggregated error
 * message to stderr and exits with code 1, which `deploy.sh`'s
 * `set -euo pipefail` propagates to the operator before `docker
 * compose up` runs.
 */
import { validateEnvAggregated } from './config/env.js';
import { formatFeatureManifest } from './config/features.js';

try {
  // Snapshot process.env into a record so the aggregated path runs
  // every cross-field guard — ALLOW_INSECURE_HTTP-in-prod, dev-default
  // credentials, container-only STORAGE_ENDPOINT — alongside the schema
  // check. validateEnvRuntime (the boot path) skips those guards
  // because start.ts runs them sequentially against the typed Env; the
  // preflight's whole purpose is to catch them BEFORE `docker compose
  // up` recreates containers, so it must run them itself per AC-231.
  const env = validateEnvAggregated({ ...process.env });

  // All output to stderr so a wrapping `docker run … 2>/dev/null` does
  // not suppress operator-visible acknowledgement. Exit 0 below
  // propagates to deploy.sh's `set -euo pipefail` as success.
  console.error('validateEnv: env validation OK.');
  console.error('');
  console.error(formatFeatureManifest(env));
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`validateEnv: env validation FAILED:\n${msg}`);
  process.exit(1);
}
