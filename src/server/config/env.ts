/**
 * Environment variable validation.
 * Fails fast at startup if required variables are missing or malformed.
 */
import { z } from 'zod';

const envSchema = z.object({
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
  STORAGE_ENDPOINT: z.string().min(1, 'STORAGE_ENDPOINT is required'),
  STORAGE_BUCKET: z.string().min(1).default('projekt-manager'),
  STORAGE_ACCESS_KEY: z.string().min(1, 'STORAGE_ACCESS_KEY is required'),
  STORAGE_SECRET_KEY: z.string().min(1, 'STORAGE_SECRET_KEY is required'),
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
