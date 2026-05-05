/**
 * Unit tests for `formatErrorChain` — the boot-time error formatter that
 * walks `err.cause` so wrapped driver errors surface their root cause.
 *
 * The motivating case: drizzle-orm wraps pg's `ECONNREFUSED` inside a
 * `DrizzleQueryError` whose own message is the failing SQL text. Without
 * walking the cause chain, the operator sees only the cryptic
 * `Failed query: SELECT hash FROM drizzle.__drizzle_migrations …` when
 * Postgres is simply down.
 */

import { describe, it, expect } from 'vitest';

import { formatErrorChain } from '../format-error-chain.js';

describe('formatErrorChain', () => {
  it('returns a single segment for a plain Error', () => {
    expect(formatErrorChain(new Error('boom'))).toBe('boom');
  });

  it('appends a string `code` when present', () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(formatErrorChain(err)).toBe('connect failed (ECONNREFUSED)');
  });

  it('walks the cause chain and joins with "caused by"', () => {
    const root = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const wrapped = Object.assign(new Error('Failed query: SELECT 1'), { cause: root });
    expect(formatErrorChain(wrapped)).toBe(
      'Failed query: SELECT 1\n  caused by: connect ECONNREFUSED 127.0.0.1:5432 (ECONNREFUSED)',
    );
  });

  it('handles a non-Error thrown value', () => {
    expect(formatErrorChain('something broke')).toBe('something broke');
    expect(formatErrorChain(undefined)).toBe('undefined');
    expect(formatErrorChain(null)).toBe('null');
  });

  it('does not loop on a self-referential cause', () => {
    const err = new Error('cycle') as Error & { cause?: unknown };
    err.cause = err;
    expect(formatErrorChain(err)).toBe('cycle');
  });
});
