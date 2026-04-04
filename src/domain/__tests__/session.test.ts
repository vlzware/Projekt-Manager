import { describe, it, expect } from 'vitest';
import { isSessionExpired } from '../session';

describe('session expiry', () => {
  // UT-12: a session past its expiresAt is treated as invalid
  it('UT-12: session past expiresAt is treated as expired', () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    expect(isSessionExpired({ expiresAt: pastDate })).toBe(true);
  });

  it('UT-12: session before expiresAt is treated as valid', () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString(); // 1 minute from now
    expect(isSessionExpired({ expiresAt: futureDate })).toBe(false);
  });
});
