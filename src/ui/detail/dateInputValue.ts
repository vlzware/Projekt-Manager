/**
 * Convert an ISO date or datetime string into a value suitable for
 * `<input type="date">`, which only accepts `YYYY-MM-DD`.
 *
 * The API returns full ISO datetimes (`2026-04-25T00:00:00.000Z`) because
 * the database column is `timestamptz`. The HTML date input will refuse to
 * display anything but `YYYY-MM-DD`, so we strip the time portion when
 * present. Already-short values pass through unchanged.
 *
 * Inputs:
 *   - `undefined` / `null` / empty string → `''`
 *   - `'2026-04-25'` → `'2026-04-25'`
 *   - `'2026-04-25T00:00:00.000Z'` → `'2026-04-25'`
 *   - `'invalid'` → `'invalid'` (the input will reject it; we don't try to
 *     "fix" invalid data here, the responsibility belongs to the API layer)
 *
 * Pure function — no Date parsing, no timezone math. The string slice is
 * safe because ISO 8601 always starts with `YYYY-MM-DD`.
 */
export function dateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.length > 10 ? iso.slice(0, 10) : iso;
}
