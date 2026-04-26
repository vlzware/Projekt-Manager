/**
 * Environment variable validation.
 * Fails fast at startup if required variables are missing or malformed.
 *
 * Two entry points (issue #139, split per #143 follow-up A-1):
 *   - `validateEnvRuntime()` — boot path; reads `process.env`, re-parses
 *     on every call. Used by start.ts, backup-runner.ts, db/connection.ts,
 *     api-helpers.ts. Runs the schema + the dev-default credential guard.
 *     The other safety guards (`assertProductionSafe`,
 *     `assertAppServerEnv`, `assertStoragePublicEndpointInProduction`)
 *     stay external so each entry point keeps control of their order
 *     and the backup-runner does not get the app-server-only narrowing.
 *     The cache that previously memoised the first parse was removed
 *     because `getRateLimit()` and other call-time consumers must reflect
 *     env mutations performed during a process's lifetime (notably
 *     vitest tests that mutate `process.env.NODE_ENV` between cases).
 *     Re-parsing is cheap; the perf cost is irrelevant against the
 *     staleness footgun the cache introduced.
 *   - `validateEnvAggregated(input)` — pure function over the supplied
 *     record. Runs the schema AND every cross-field guard in one pass,
 *     aggregating every offence into ONE thrown error so an operator
 *     sees every fault in a single failed deploy, not one-per-reboot.
 *     Used by the deploy pre-flight CLI and by tests.
 */
import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Default to 'production' so the production-safety checks (see
  // assertProductionSafe below) fire when NODE_ENV is unset. The previous
  // default ('development') once let the binary start with
  // ALLOW_INSECURE_HTTP=true when NODE_ENV was not explicitly set —
  // closing that hole is the whole point of this default. Dev workflows
  // must set NODE_ENV=development explicitly (docker-compose.dev.yml,
  // .env.example). 'test' is accepted because vitest sets it by default;
  // it is treated the same as 'development' by assertProductionSafe and
  // getCookieSecure (neither considers it 'production'). See ADR-0013 and
  // iteration 5 consolidation review C-2.
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // STORAGE_* is the app server's MinIO surface (attachments). The backup
  // service (ADR-0020) doesn't touch it — it uses R2_* instead. Optional
  // here so the shared validateEnvRuntime() call in backup-runner.ts doesn't
  // reject for vars the backup path never reads; `assertAppServerEnv()`
  // below (called only from start.ts) enforces presence for the app path.
  STORAGE_ENDPOINT: z.string().optional(),
  // Optional public hostname the browser uses to reach MinIO. The app
  // signs presigned POST / GET URLs against this endpoint (not
  // STORAGE_ENDPOINT, which points at the Docker-internal hostname).
  // Required in production when STORAGE_ENDPOINT is a container-only
  // host — enforced by `assertStoragePublicEndpointInProduction()`.
  STORAGE_PUBLIC_ENDPOINT: z.string().optional(),
  STORAGE_BUCKET: z.string().min(1).default('projekt-manager'),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  DOMAIN: z.string().default('localhost'),
  SEED: z.enum(['true', 'false', 'force']).default('false'),
  // First-run admin bootstrap — see ADR-0010 and issue #57. All three are
  // optional; validation of the "both or neither" pairing and the password
  // policy happens in src/server/bootstrap.ts where the schema check would
  // be too coarse.
  // When true, disables the Secure flag on session cookies so login works
  // over plain HTTP. Intended for evaluation deployments without a domain/TLS.
  // See docs/ops/http-only-evaluation.md.
  ALLOW_INSECURE_HTTP: z.enum(['true', 'false']).default('false'),
  BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  BOOTSTRAP_ADMIN_DISPLAY_NAME: z.string().optional(),
  // OpenRouter LLM extraction (ADR-0016). Optional — feature is disabled
  // when the key is absent.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.5-flash-lite'),
  // How often the periodic session reaper sweeps expired sessions.
  // Default 60 min is the same cadence the startup-only cleanup used to
  // provide implicitly via server restarts; lower values are fine for
  // environments that want tighter revocation latency.
  SESSION_CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  // Audit-log retention window in days — [C] per architecture.md §12.2
  // and data-model.md §6.10. When unset, the build-time default in
  // `src/config/auditRetention.ts` (90 d) applies. Coerced to integer
  // because a fractional day window makes no sense for a rolling
  // cleanup and the AC-184 log line types `window_days` as integer.
  // preprocess: compose forwards this as `${AUDIT_RETENTION_WINDOW_DAYS:-}`,
  // so an unset var arrives as "" — which `z.coerce.number()` turns into 0
  // and `.positive()` then rejects. Map "" → undefined so .optional() takes
  // over and start.ts falls back to the build-time default.
  AUDIT_RETENTION_WINDOW_DAYS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  // How often the audit-retention cleanup runs. One run is a single
  // indexed DELETE against the `audit_log_created_at_idx`; daily (1440
  // min) is the production default because retention is a cleanup, not
  // a latency-sensitive sweep. Overridable per deployment — tests leave
  // the scheduler untouched and call the service directly.
  AUDIT_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  // Login-rate-limit ceiling — moved into the schema in #139 to close the
  // last raw-`process.env` read inside the configuration boundary
  // (AC-228). The build-time default in `getRateLimit()` is environment-
  // aware (5/min in production, 30/min elsewhere); this override applies
  // when the operator sets a numeric value. Same `${VAR:-}` empty-string
  // preprocess as AUDIT_RETENTION_WINDOW_DAYS.
  LOGIN_RATE_LIMIT_MAX: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  // ---------------------------------------------------------------
  // Layer 2 backup (ADR-0020). Consumed by the `backup-runner` CLI,
  // not by the main app server — but declared here so the schema
  // remains the single source of truth. Optional at the app-server
  // level; the CLI enforces presence at dispatch time, and the shell
  // entrypoints in scripts/backup/run-*.sh pre-check the same set.
  // ---------------------------------------------------------------
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_REGION: z.string().default('auto'),
  /** Public age recipient (asymmetric). Encryption fails fast if empty
   * to preserve the "no plaintext at rest" invariant (AC-167). */
  AGE_RECIPIENT: z.string().optional(),
  /** Tmpfs-resident identity path used by the drill decrypt step.
   * Default matches `scripts/backup/run-drill.sh` and the tmpfs mount
   * in Dockerfile.backup so operators don't need to set it. */
  AGE_IDENTITY_PATH: z.string().default('/run/drill-key/identity'),
  // ---------------------------------------------------------------
  // Web Push / VAPID (architecture.md §11.11). The public key is derived
  // from the private half at startup (P-256 ECDSA — `src/server/config/vapid.ts`),
  // so the operator only maintains the private key. In production,
  // missing `VAPID_PRIVATE_KEY` falls back to `noopPushDispatcher` with
  // a startup warn. In dev/test the helper auto-generates a key into
  // `data/.vapid/private-key` on first boot so push works zero-config.
  // `VAPID_SUBJECT` must be either a `mailto:` URL or an `https:` URL
  // per RFC 8292 §2.1 — format validated at WebPushDispatcher boot.
  // ---------------------------------------------------------------
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  // ---------------------------------------------------------------
  // Attachments (data-model.md §5.13, architecture.md §12.2).
  // All four overrides follow the "empty string → undefined" pattern
  // so docker-compose's `${VAR:-}` forward does not collapse an unset
  // variable into 0 (which `.positive()` would then reject). Build-time
  // defaults live in `src/config/attachmentConfig.ts`.
  // ---------------------------------------------------------------
  ATTACHMENT_PER_FILE_CAP_BYTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_BULK_MAX_FILES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_BULK_MAX_BYTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_ORPHAN_REAPER_TTL_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_WORKER_SELF_DELETE_GRACE_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  ATTACHMENT_ORPHAN_REAPER_INTERVAL_MINUTES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Known dev-default credentials forwarded to the app container by
 * docker-compose. Each entry pairs an env-var name with the values that
 * ship in the dev compose file — if any of these reach a production
 * container, the operator forgot to override them.
 *
 * Forwarded explicitly so the names appear in `process.env` (compose's
 * `environment:` block forwards POSTGRES_PASSWORD / MINIO_ROOT_USER /
 * MINIO_ROOT_PASSWORD into the app service alongside DATABASE_URL etc.).
 */
const DEV_DEFAULT_CREDENTIALS: ReadonlyArray<{ envVar: string; values: readonly string[] }> = [
  { envVar: 'POSTGRES_PASSWORD', values: ['postgres', 'devpassword'] },
  { envVar: 'MINIO_ROOT_USER', values: ['minioadmin'] },
  { envVar: 'MINIO_ROOT_PASSWORD', values: ['minioadmin'] },
];

/**
 * Aggregates dev-default credential offences into the supplied issue list.
 * Only fires in production; out-of-prod environments need their dev
 * defaults to keep working.
 *
 * Pure-function shape — no throws, no I/O — so the aggregating validator
 * can call it alongside the schema's safeParse output and the cross-field
 * guards in a single pass.
 */
export function assertNoDevCredentials(
  source: Record<string, string | undefined>,
  issues: string[],
): void {
  if (source.NODE_ENV !== 'production') return;
  for (const { envVar, values } of DEV_DEFAULT_CREDENTIALS) {
    const current = source[envVar];
    if (current !== undefined && values.includes(current)) {
      issues.push(
        `${envVar} is set to the dev default "${current}". Set a secure value for production.`,
      );
    }
  }
}

/**
 * Boot path. Parses `process.env`, returns the typed `Env`. Runs the
 * schema + `assertNoDevCredentials` so a forgotten dev-default credential
 * trips at boot regardless of which binary started — start.ts and
 * backup-runner.ts share this one check. The other cross-field guards
 * (`assertProductionSafe`, `assertAppServerEnv`,
 * `assertStoragePublicEndpointInProduction`) stay external so the caller
 * keeps control of their order and so the app-server-only narrowing
 * (`assertAppServerEnv`) doesn't reject the backup-runner path.
 */
export function validateEnvRuntime(): Env {
  return parseAndAggregate(process.env, { runAllGuards: false });
}

/**
 * Pre-flight / test path. Pure function over the supplied record. Runs
 * the schema AND every cross-field guard in one pass; all offences are
 * aggregated into a single thrown Error so a misconfigured deploy
 * iterates once, not N times (issue #139, AC-231).
 */
export function validateEnvAggregated(input: Record<string, string | undefined>): Env {
  return parseAndAggregate(input, { runAllGuards: true });
}

/**
 * Access the validated env. Re-parses `process.env` on every call (see
 * file header for rationale). Throws if validation fails — same surface
 * as `validateEnvRuntime()`.
 */
export function getEnv(): Env {
  return validateEnvRuntime();
}

/**
 * Run the schema and (optionally) every cross-field guard, accumulating
 * issues into a single thrown error. The `runAllGuards` switch controls
 * whether the cross-field guards (assertProductionSafe and friends) run
 * in this pass: `validateEnvAggregated` passes `true` to surface every
 * offence at once; `validateEnvRuntime` passes `false` because start.ts
 * calls those guards itself with the typed `Env` afterwards (this
 * avoids double-running them and preserves the historical wiring).
 *
 * `assertNoDevCredentials` runs in BOTH paths because rejecting dev
 * defaults is the only guard that depends on the raw input map (the
 * compose-forwarded vars are not part of the typed `Env`).
 *
 * Cross-field guards in the aggregated path operate on `source`
 * directly (not the parsed Env) so a schema failure on one field does
 * not silence the guard for an unrelated field. AC-231 wants every
 * offence reported in one pass — so a `PORT=0` Zod failure must NOT
 * mask `ALLOW_INSECURE_HTTP=true in production`.
 */
function parseAndAggregate(
  source: Record<string, string | undefined>,
  opts: { runAllGuards: boolean },
): Env {
  const issues: string[] = [];
  const result = envSchema.safeParse(source);
  if (!result.success) {
    for (const i of result.error.issues) {
      const pathStr = i.path.length > 0 ? i.path.join('.') : '<root>';
      issues.push(`${pathStr}: ${i.message}`);
    }
  }

  if (opts.runAllGuards) {
    aggregateProductionSafe(source, issues);
    aggregateAppServerEnv(source, issues);
    aggregateStoragePublicEndpointInProduction(source, issues);
  }

  // Dev-credential check uses the raw source map, so it can fire
  // regardless of whether the schema parse succeeded.
  assertNoDevCredentials(source, issues);

  if (issues.length > 0) {
    throw new Error(`Environment validation failed:\n${issues.map((m) => `  - ${m}`).join('\n')}`);
  }
  // Issues empty ⇒ schema succeeded — every Zod failure was pushed into
  // `issues` above, so reaching this point with `result.success === false`
  // is impossible.
  if (!result.success) throw new Error('unreachable: schema fail did not push issues');
  return result.data;
}

/**
 * Aggregated mirror of `assertProductionSafe` operating on the raw
 * source map. Used by the aggregated validator so a schema failure on an
 * unrelated field cannot mask an ALLOW_INSECURE_HTTP=true offence.
 *
 * Exported guard `assertProductionSafe` (typed Env) remains the contract
 * for start.ts and unit tests; this helper is the same predicate over
 * raw input.
 */
// Shared error messages — used by both the typed-Env throw helpers
// (assertProductionSafe etc.) and their raw-source aggregating mirrors
// (aggregateProductionSafe etc.). Keeping the strings in one place avoids
// silent drift between the two paths.

const ALLOW_INSECURE_HTTP_IN_PROD_MSG =
  'Refusing to start: ALLOW_INSECURE_HTTP=true in production. ' +
  'This disables cookie security. Remove ALLOW_INSECURE_HTTP or set NODE_ENV=development.';

function appServerMissingMsg(missing: ReadonlyArray<string>): string {
  return (
    `App server requires these env vars: ${missing.join(', ')}. ` +
    'They are optional in the shared schema so the backup-runner CLI ' +
    'can share validateEnvRuntime(), but the app server cannot start without them.'
  );
}

function storagePublicEndpointMsg(endpoint: string): string {
  return (
    `Refusing to start: STORAGE_ENDPOINT (${endpoint}) is a container-only ` +
    'hostname but STORAGE_PUBLIC_ENDPOINT is not set. Presigned URLs the browser ' +
    'receives would be unreachable. Set STORAGE_PUBLIC_ENDPOINT to the public ' +
    'URL that reverse-proxies to MinIO (e.g. https://storage.<your-domain>). ' +
    'See docs/ops/storage-subdomain.md.'
  );
}

function aggregateProductionSafe(
  source: Record<string, string | undefined>,
  issues: string[],
): void {
  if (source.NODE_ENV === 'production' && source.ALLOW_INSECURE_HTTP === 'true') {
    issues.push(ALLOW_INSECURE_HTTP_IN_PROD_MSG);
  }
}

/**
 * Aggregated mirror of `assertAppServerEnv` operating on raw source.
 * Reports every missing STORAGE_* var in a single message — same shape
 * as the typed-Env guard so the test message contract holds.
 */
function aggregateAppServerEnv(source: Record<string, string | undefined>, issues: string[]): void {
  const missing: string[] = [];
  if (!source.STORAGE_ENDPOINT) missing.push('STORAGE_ENDPOINT');
  if (!source.STORAGE_ACCESS_KEY) missing.push('STORAGE_ACCESS_KEY');
  if (!source.STORAGE_SECRET_KEY) missing.push('STORAGE_SECRET_KEY');
  if (missing.length > 0) {
    issues.push(appServerMissingMsg(missing));
  }
}

/**
 * Aggregated mirror of `assertStoragePublicEndpointInProduction`
 * operating on raw source.
 */
function aggregateStoragePublicEndpointInProduction(
  source: Record<string, string | undefined>,
  issues: string[],
): void {
  if (source.NODE_ENV !== 'production') return;
  const endpoint = source.STORAGE_ENDPOINT;
  if (!endpoint) return; // covered by aggregateAppServerEnv
  if (source.STORAGE_PUBLIC_ENDPOINT) return;
  if (!hostnameLooksInternal(endpoint)) return;
  issues.push(storagePublicEndpointMsg(endpoint));
}

/**
 * Assert startup safety invariants that depend on NODE_ENV. Called from
 * start.ts right after validateEnvRuntime(). Extracted so a unit test can exercise
 * the exact guard that ships, without spawning the server.
 *
 * Currently enforces: in production, ALLOW_INSECURE_HTTP must not be 'true'.
 * ADR-0013 promises the server refuses to start on this combination; this
 * function is that promise. See also AC-45 and consolidation review C-2/C-4.
 */
export function assertProductionSafe(env: Env): void {
  if (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_HTTP === 'true') {
    throw new Error(ALLOW_INSECURE_HTTP_IN_PROD_MSG);
  }
}

/**
 * Hostname-looks-internal heuristic: no dot and not an IP literal. The
 * Docker-internal hostnames used by compose (`storage`, `db`, `app`) all
 * hit this, whereas a public URL (`storage.example.com`) does not. Used
 * only by `assertStoragePublicEndpointInProduction()` — a literal IP
 * (`http://10.0.0.5:9000`) is legitimate in self-hosted setups and is
 * NOT treated as internal.
 */
function hostnameLooksInternal(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    // Malformed endpoint — let the storage client surface the real error
    // at connect time rather than double-reporting it here.
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return !host.includes('.');
}

/**
 * Refuses to start in production when the storage client would sign
 * presigned URLs against a container-only hostname. Without
 * `STORAGE_PUBLIC_ENDPOINT`, the app signs URLs using `STORAGE_ENDPOINT`
 * (e.g. `http://storage:9000`) and hands them to the browser — which
 * cannot resolve the Docker-internal host, so every upload POST fails
 * silently and the `pending → ready` transition never happens. That
 * defect sat on the VPS undetected until an operator noticed attachments
 * never saving.
 *
 * Dev (STORAGE_ENDPOINT = localhost or an IP) does not trip this guard
 * because dev exposes MinIO on the host; the browser reaches the same
 * endpoint the app reaches.
 */
export function assertStoragePublicEndpointInProduction(env: Env): void {
  if (env.NODE_ENV !== 'production') return;
  if (!env.STORAGE_ENDPOINT) return; // assertAppServerEnv already reports this
  if (env.STORAGE_PUBLIC_ENDPOINT) return;
  if (!hostnameLooksInternal(env.STORAGE_ENDPOINT)) return;
  throw new Error(storagePublicEndpointMsg(env.STORAGE_ENDPOINT));
}

/**
 * `Env` with the STORAGE_* fields narrowed to non-nullable strings —
 * the shape the app server sees after `assertAppServerEnv()` succeeds.
 */
export type AppServerEnv = Env & {
  STORAGE_ENDPOINT: string;
  STORAGE_ACCESS_KEY: string;
  STORAGE_SECRET_KEY: string;
};

/**
 * App-server-only presence check for the MinIO-backed attachment storage
 * config. The shared schema keeps these optional so the backup-runner CLI
 * (which doesn't use MinIO) can pass validateEnvRuntime(); this guard restores
 * the fail-fast semantic for the app server and narrows the type so the
 * downstream calls in start.ts don't need `!` non-null assertions.
 */
export function assertAppServerEnv(env: Env): asserts env is AppServerEnv {
  const missing: string[] = [];
  if (!env.STORAGE_ENDPOINT) missing.push('STORAGE_ENDPOINT');
  if (!env.STORAGE_ACCESS_KEY) missing.push('STORAGE_ACCESS_KEY');
  if (!env.STORAGE_SECRET_KEY) missing.push('STORAGE_SECRET_KEY');
  if (missing.length > 0) {
    throw new Error(appServerMissingMsg(missing));
  }
}
