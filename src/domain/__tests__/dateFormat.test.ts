import { describe, it, expect } from 'vitest';
import { formatDateOnly } from '../dateFormat';

describe('formatDateOnly', () => {
  it('returns the local calendar date of the given Date instance', () => {
    // `new Date(2026, 6, 1)` always represents 2026-07-01 00:00 in the
    // local timezone, regardless of system TZ — so the local calendar
    // date is always 2026-07-01. The previously-used pattern
    // `d.toISOString().slice(0, 10)` returns the UTC date, which under
    // TZ east of UTC would yield 2026-06-30 here.
    expect(formatDateOnly(new Date(2026, 6, 1))).toBe('2026-07-01');
  });

  it('pads month and day to two digits', () => {
    expect(formatDateOnly(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatDateOnly(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('mirrors native local-component getters', () => {
    const d = new Date('2026-03-15T10:30:00Z');
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    expect(formatDateOnly(d)).toBe(`${y}-${m}-${dd}`);
  });
});
