/**
 * Pre-flight env validation entry point. Invoked by `scripts/deploy.sh`
 * INSIDE a one-shot `docker run --rm` against the just-pulled deploy
 * image. The bundled output ships at `dist/server/validate-env-cli.js`
 * (esbuild target list in `package.json` > `build:server`); the host-
 * side `deploy.sh` does not need any project node_modules — it only
 * needs Docker.
 *
 * Why a dedicated entry:
 *   - The aggregated validator lives in `config/env.ts`. The existing
 *     `start.ts` entry point validates AND boots Fastify, opens DB
 *     pool, runs migrations — running it with the `up`-side effects to
 *     JUST check env would double-bind the port and race the eventual
 *     `docker compose up`. A dedicated CLI runs validation only and
 *     exits.
 *   - Bundling keeps the "shells out to validateEnvAggregated" contract
 *     stable across schema refactors. The host-side script doesn't need
 *     to track esbuild's chunk-emission decisions.
 *
 * Aborts the deploy on first failure: prints the aggregated error
 * message to stderr and exits with code 1, which `deploy.sh`'s
 * `set -euo pipefail` propagates to the operator before `docker
 * compose up` runs.
 */
import { validateEnvAggregated } from './config/env.js';

try {
  // Snapshot process.env into a record so the aggregated path runs
  // every cross-field guard — ALLOW_INSECURE_HTTP-in-prod, dev-default
  // credentials, container-only STORAGE_ENDPOINT — alongside the schema
  // check. validateEnvRuntime (the boot path) skips those guards
  // because start.ts runs them sequentially against the typed Env; the
  // preflight's whole purpose is to catch them BEFORE `docker compose
  // up` recreates containers, so it must run them itself per AC-231.
  validateEnvAggregated({ ...process.env });
  // Use stderr so a wrapping `docker run … 2>/dev/null` does not
  // suppress success acknowledgement (operator should see "OK" so
  // they know the step ran rather than was skipped). Exit 0.
  console.error('validateEnv: env validation OK.');
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`validateEnv: env validation FAILED:\n${msg}`);
  process.exit(1);
}
