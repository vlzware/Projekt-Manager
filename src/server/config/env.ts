/**
 * Environment variable validation.
 * Fails fast at startup if required variables are missing or malformed.
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
  // here so the shared validateEnv() call in backup-runner.ts doesn't
  // reject for vars the backup path never reads; `assertAppServerEnv()`
  // below (called only from start.ts) enforces presence for the app path.
  STORAGE_ENDPOINT: z.string().optional(),
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
  // Web Push / VAPID (ADR-0023). All three must be present for real
  // push transport; when any is missing the app composition falls
  // back to `noopPushDispatcher` and logs a one-line warn on start.
  // The public key is served to the client via GET /api/push/vapid-
  // public-key (api.md §14.2.10) so the operator only needs to set
  // it once (server-side). `VITE_VAPID_PUBLIC_KEY` is retained as an
  // offline-dev fallback on the client; the endpoint is primary.
  // `VAPID_SUBJECT` must be either a `mailto:` URL or an `https:`
  // URL per RFC 8292 §2.1 — validated at WebPushDispatcher boot, not
  // here, because the format check belongs with the consumer.
  // ---------------------------------------------------------------
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/**
 * Parse and validate environment variables.
 * Call once at startup. Throws with descriptive errors on invalid config.
 */
export function validateEnv(): Env {
  if (_env) return _env;
  _env = envSchema.parse(process.env);
  return _env;
}

/**
 * Access validated env. Throws if validateEnv() hasn't been called.
 */
export function getEnv(): Env {
  if (!_env) throw new Error('Environment not validated. Call validateEnv() first.');
  return _env;
}

/**
 * Assert startup safety invariants that depend on NODE_ENV. Called from
 * start.ts right after validateEnv(). Extracted so a unit test can exercise
 * the exact guard that ships, without spawning the server.
 *
 * Currently enforces: in production, ALLOW_INSECURE_HTTP must not be 'true'.
 * ADR-0013 promises the server refuses to start on this combination; this
 * function is that promise. See also AC-45 and consolidation review C-2/C-4.
 */
export function assertProductionSafe(env: Env): void {
  if (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_HTTP === 'true') {
    throw new Error(
      'Refusing to start: ALLOW_INSECURE_HTTP=true in production. ' +
        'This disables cookie security. Remove ALLOW_INSECURE_HTTP or set NODE_ENV=development.',
    );
  }
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
 * (which doesn't use MinIO) can pass validateEnv(); this guard restores
 * the fail-fast semantic for the app server and narrows the type so the
 * downstream calls in start.ts don't need `!` non-null assertions.
 */
export function assertAppServerEnv(env: Env): asserts env is AppServerEnv {
  const missing: string[] = [];
  if (!env.STORAGE_ENDPOINT) missing.push('STORAGE_ENDPOINT');
  if (!env.STORAGE_ACCESS_KEY) missing.push('STORAGE_ACCESS_KEY');
  if (!env.STORAGE_SECRET_KEY) missing.push('STORAGE_SECRET_KEY');
  if (missing.length > 0) {
    throw new Error(
      `App server requires these env vars: ${missing.join(', ')}. ` +
        'They are optional in the shared schema so the backup-runner CLI ' +
        'can share validateEnv(), but the app server cannot start without them.',
    );
  }
}
