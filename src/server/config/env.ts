/**
 * Environment variable validation.
 * Fails fast at startup if required variables are missing or malformed.
 */
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  STORAGE_ENDPOINT: z.string().min(1, 'STORAGE_ENDPOINT is required'),
  STORAGE_BUCKET: z.string().min(1).default('projekt-manager'),
  STORAGE_ACCESS_KEY: z.string().min(1, 'STORAGE_ACCESS_KEY is required'),
  STORAGE_SECRET_KEY: z.string().min(1, 'STORAGE_SECRET_KEY is required'),
  DOMAIN: z.string().default('localhost'),
  SEED: z.enum(['true', 'false', 'force']).default('false'),
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
