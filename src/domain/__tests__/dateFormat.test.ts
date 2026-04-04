import { describe, it, expect } from 'vitest';
import { formatDateRange } from '../dateFormat';

describe('formatDateRange', () => {
  // Finding 3 (R2): edge case — only plannedEnd set, no plannedStart.
  // This can occur when a user clears the start date but not the end date.
  // Current behavior: returns 'Kein Termin' (same as no dates at all).
  it('returns "Kein Termin" when only end date is provided (no start)', () => {
    expect(formatDateRange(undefined, '2026-04-15')).toBe('Kein Termin');
  });
});
