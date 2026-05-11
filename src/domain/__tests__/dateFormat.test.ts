import { describe, it, expect } from 'vitest';
import { formatBackupTimestampDE, formatDateOnly } from '../dateFormat';

describe('formatBackupTimestampDE', () => {
  // Local-time ISO strings (no `Z`) keep the assertions deterministic
  // across CI timezones — `parseISO` interprets them in the runner's
  // local zone, so the formatted output is the same regardless of where
  // the test executes. The backup status row stores the actual run
  // timestamp; the badge surfaces it in the operator's local zone.
  it('formats as HH:mm EEE dd.MM.yyyy with German weekday', () => {
    expect(formatBackupTimestampDE('2026-04-26T14:00:00')).toBe('14:00 So. 26.04.2026');
  });

  it('uses the correct German weekday abbreviation for a weekday run', () => {
    // 2026-04-22 falls on a Wednesday — guards against a regression that
    // hardcodes a single weekday or off-by-one's the day index.
    expect(formatBackupTimestampDE('2026-04-22T09:30:00')).toBe('09:30 Mi. 22.04.2026');
  });

  it('zero-pads hour, minute, day, and month', () => {
    expect(formatBackupTimestampDE('2026-01-05T03:07:00')).toBe('03:07 Mo. 05.01.2026');
  });
});

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
});
