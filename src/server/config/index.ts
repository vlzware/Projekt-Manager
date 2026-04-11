/**
 * Centralized server configuration constants.
 *
 * All policy-level values that were previously scattered across route handlers
 * and service modules live here. Environment-dependent values are resolved
 * via getEnv() at call time — never from process.env at import time, because
 * that bypass let ALLOW_INSECURE_HTTP and NODE_ENV be read from the raw env
 * even after env.ts validated a different value (consolidation review C-3).
 */

import { getEnv } from './env.js';

// --- Authentication & Sessions -----------------------------------------------

export const AUTH_CONFIG = {
  /** How long a session cookie stays valid. */
  sessionDurationMs: 24 * 60 * 60 * 1000, // 24 hours

  /** Cookie maxAge in seconds (must match sessionDurationMs). */
  cookieMaxAgeSec: 86_400, // 24 hours

  /**
   * Pre-computed bcrypt hash used to equalise timing when user is not found.
   * The actual plaintext is irrelevant — we only need bcrypt to burn the same
   * CPU time as a real comparison.
   */
  dummyHash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
} as const;

/**
 * Whether to set the `Secure` flag on session cookies.
 *
 * Production with real TLS → true. Explicit HTTP evaluation mode
 * (ALLOW_INSECURE_HTTP=true, see ADR-0013) → false. Development → false.
 *
 * Reads from the validated env (env.ts) — requires validateEnv() to have
 * been called first (start.ts does this before buildApp()). Tests use
 * startApp() in api-helpers.ts which also calls validateEnv().
 */
export function getCookieSecure(): boolean {
  const env = getEnv();
  return env.NODE_ENV === 'production' && env.ALLOW_INSECURE_HTTP !== 'true';
}

// --- Rate Limiting -----------------------------------------------------------

export const RATE_LIMIT = {
  /** Login endpoint. */
  login: { max: 5, timeWindow: '1 minute' },

  /** Password change endpoint. */
  passwordChange: { max: 5, timeWindow: '1 minute' },
} as const;

// --- Storage -----------------------------------------------------------------

export const STORAGE_CONFIG = {
  /** Allowed pattern for object storage keys (prevents path traversal). */
  validKeyPattern: /^[a-zA-Z0-9/_.-]{1,1024}$/,

  /** Minimum signed URL expiry in seconds. */
  minSignedUrlExpirySec: 1,

  /** Maximum signed URL expiry in seconds. */
  maxSignedUrlExpirySec: 3600,
} as const;
