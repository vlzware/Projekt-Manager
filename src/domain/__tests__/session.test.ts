import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isSessionExpired } from '../session';

describe('session expiry', () => {
  // Freeze the clock so expiry arithmetic is deterministic and not susceptible
  // to slow test runs, clock drift, or DST weirdness.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
