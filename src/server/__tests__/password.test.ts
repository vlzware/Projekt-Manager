/**
 * Unit tests for server password hashing primitives.
 *
 * Covers UT-10 and UT-11 from the test specification (verification.md §16.1).
 *
 * These are pure unit tests — no database, no Fastify. They live under
 * src/server/__tests__/ because they test server-side code (src/server/password.ts);
 * co-locating them with other server tests keeps the boundary between
 * `src/domain` (pure domain logic) and `src/server` (server primitives) honest.
 *
 * Per vitest.config.ts, every file in src/server/__tests__/ runs under the
 * `integration` project (node environment, no file-level parallelism). That
 * is fine: these tests don't need the DB, and the sequential runner has no
 * negative effect on two quick bcrypt round-trips.
 */

import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../password.js';

describe('password hashing', () => {
  // UT-10: a hashed password does not match a different plaintext
  it('UT-10: hashed password does not match a different plaintext', async () => {
    const hash = await hashPassword('correct-password');
    const result = await verifyPassword('wrong-password', hash);
    expect(result).toBe(false);
  });

  // UT-11: a hashed password matches the original plaintext
  it('UT-11: hashed password matches the original plaintext', async () => {
    const plain = 'my-secret-password';
    const hash = await hashPassword(plain);
    expect(hash).not.toBe(plain);
    const result = await verifyPassword(plain, hash);
    expect(result).toBe(true);
  });
});
