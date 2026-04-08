/**
 * Tests for the dateInputValue helper.
 *
 * Covers the regression class the helper exists to prevent: ISO datetimes
 * from the API rendering as blank in <input type="date">.
 */

import { describe, it, expect } from 'vitest';
import { dateInputValue } from '../dateInputValue';

describe('dateInputValue', () => {
  it('returns empty string for undefined', () => {
    expect(dateInputValue(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(dateInputValue(null)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(dateInputValue('')).toBe('');
  });

  it('passes through a short YYYY-MM-DD value unchanged', () => {
    expect(dateInputValue('2026-04-25')).toBe('2026-04-25');
  });

  it('strips the time portion of a full ISO datetime', () => {
    expect(dateInputValue('2026-04-25T00:00:00.000Z')).toBe('2026-04-25');
  });

  it('strips the time portion regardless of timezone offset', () => {
    expect(dateInputValue('2026-04-25T22:30:00+02:00')).toBe('2026-04-25');
  });

  it('handles a date-only value with no time even if longer than 10 chars (defensive)', () => {
    // Sanity check on the slice cutoff: anything past 10 chars is dropped.
    // This input shape should not occur in practice (the API returns either
    // YYYY-MM-DD or a full ISO datetime), but the helper must not corrupt it.
    expect(dateInputValue('2026-04-25 ')).toBe('2026-04-25');
  });

  it('passes through an invalid short string unchanged (the input element will reject it)', () => {
    // The helper does not validate — it strips the time component or returns
    // empty. Validation belongs upstream (the API serializer).
    expect(dateInputValue('xyz')).toBe('xyz');
  });
});
