/**
 * Pure date helper for the seed loader.
 *
 * Returns a new `Date` shifted by `days` from `now`, with time components
 * zeroed (local timezone). The `now` parameter is explicit so callers can
 * thread a single reference moment through an entire seed build — avoids
 * the subtle year-rollover / off-by-a-few-ms bugs that appear when each
 * helper call captures `new Date()` on its own.
 */
export function daysFromNow(now: Date, days: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
}
