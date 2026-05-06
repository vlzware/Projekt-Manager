/**
 * Walk the `err.cause` chain so wrapped driver errors surface their
 * underlying cause and SQLSTATE/errno code at boot. Without this,
 * drizzle-orm wrapping pg's `ECONNREFUSED` inside a `DrizzleQueryError`
 * (whose own message is just the failing SQL text) leaves the operator
 * with `Failed to start server: Failed query: SELECT …` and no hint
 * that Postgres is simply down.
 */
export function formatErrorChain(err: unknown): string {
  const segments: string[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const message = (cur as { message?: unknown }).message;
    const code = (cur as { code?: unknown }).code;
    const text = typeof message === 'string' ? message : String(cur);
    segments.push(typeof code === 'string' ? `${text} (${code})` : text);
    cur = (cur as { cause?: unknown }).cause;
  }
  return segments.length > 0 ? segments.join('\n  caused by: ') : String(err);
}
