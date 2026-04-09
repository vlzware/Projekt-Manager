import { describe, it, expect } from 'vitest';
import { formatDateRange, formatCurrencyDE } from '../dateFormat';

// Covers all four branches of formatDateRange:
//   1. start missing         -> 'Kein Termin'
//   2. start only            -> long German format
//   3. same-year range       -> short start + long end, separated by en-dash
//   4. cross-year range      -> long start + long end, separated by en-dash
// And both representative cases of formatCurrencyDE (zero + positive).
// Date ranges use U+2013 (EN DASH) and the currency output uses U+00A0
// (NO-BREAK SPACE) between the amount and the euro sign — these escapes are
// the actual bytes produced by Intl/date-fns, verified against the live
// functions. Do not "clean up" the escapes without re-verifying.
describe('formatDateRange', () => {
  // Finding 3 (R2): edge case — only plannedEnd set, no plannedStart.
  // This can occur when a user clears the start date but not the end date.
  // Current behavior: returns 'Kein Termin' (same as no dates at all).
  it('returns "Kein Termin" when only end date is provided (no start)', () => {
    expect(formatDateRange(undefined, '2026-04-15')).toBe('Kein Termin');
  });

  it('returns long German format when only start date is provided', () => {
    expect(formatDateRange('2026-04-15', undefined)).toBe('15.04.2026');
  });

  it('returns short start + long end when range is within the same year', () => {
    expect(formatDateRange('2026-04-01', '2026-04-15')).toBe('01.04. \u2013 15.04.2026');
  });

  it('returns long start + long end when range spans different years', () => {
    expect(formatDateRange('2025-12-15', '2026-01-15')).toBe('15.12.2025 \u2013 15.01.2026');
  });
});

describe('formatCurrencyDE', () => {
  it('formats zero in German Euro format', () => {
    expect(formatCurrencyDE(0)).toBe('0,00\u00a0\u20ac');
  });

  it('formats a positive value with thousands separator and two decimals', () => {
    expect(formatCurrencyDE(1234.56)).toBe('1.234,56\u00a0\u20ac');
  });
});
