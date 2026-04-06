/**
 * Centralized server configuration constants.
 *
 * All policy-level values that were previously scattered across route handlers
 * and service modules live here. Environment-dependent values are read from
 * process.env at import time (validated separately in env.ts once Zod is added).
 */

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

  /** Whether to set the Secure flag on cookies (HTTPS only). */
  cookieSecure: process.env.NODE_ENV === 'production',
} as const;

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
