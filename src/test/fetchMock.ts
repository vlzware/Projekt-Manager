/**
 * Test helpers for stubbing `globalThis.fetch` in component tests.
 *
 * The Wave 2 audit found that relying on the default stub in
 * `src/test/setup.ts` (which silently returned 200 `{}`) let mutation tests
 * pass without exercising the API integration at all. The new default there
 * rejects loudly — every test that calls fetch must configure its own spy.
 *
 * Usage:
 *
 * ```ts
 * import { installFailingFetch, mockFetchJson, mockFetchError } from '@/test/fetchMock';
 *
 * let fetchSpy: ReturnType<typeof installFailingFetch>;
 *
 * beforeEach(() => {
 *   fetchSpy = installFailingFetch();
 * });
 *
 * it('does a thing', async () => {
 *   mockFetchJson(fetchSpy, { id: 'p07', status: 'in_arbeit' });
 *   // ... interact with the UI ...
 *   expect(fetchSpy).toHaveBeenCalledWith(
 *     '/api/projects/p07/transition/forward',
 *     expect.objectContaining({ method: 'POST' }),
 *   );
 * });
 * ```
 *
 * The reference pattern is `src/ui/__tests__/auth.test.tsx`.
 */

import { vi, type MockInstance } from 'vitest';

export type FetchSpy = MockInstance<typeof fetch>;

/**
 * Replace `globalThis.fetch` with a spy that rejects with a loud error.
 * Call this in `beforeEach`. Each test that needs a successful (or explicit
 * error) response must then call `mockFetchJson` / `mockFetchError` /
 * `mockFetchNetworkError` on the returned spy.
 */
export function installFailingFetch(): FetchSpy {
  const spy = vi.spyOn(globalThis, 'fetch') as FetchSpy;
  spy.mockRejectedValue(
    new Error(
      'fetch not configured for this test — call mockFetchJson(fetchSpy, ...) ' +
        'or mockFetchError(fetchSpy, ...) before triggering the mutation.',
    ),
  );
  return spy;
}

/**
 * Queue a single successful JSON response on the spy.
 * Follow-up fetch calls fall through to whatever is next in the queue, or
 * back to the rejection default.
 */
export function mockFetchJson<T>(spy: FetchSpy, body: T, status = 200): void {
  spy.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/**
 * Queue a single non-2xx JSON response on the spy. Use for deliberate API
 * failure scenarios (e.g. 500 server error, 409 conflict). Don't use this
 * for network-level failures — use `mockFetchNetworkError` instead.
 */
export function mockFetchError(spy: FetchSpy, status = 500, body: unknown = {}): void {
  spy.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/**
 * Queue a single network-level failure on the spy (fetch itself throws).
 * Mirrors the shape the browser produces when the request can't reach the
 * server at all.
 */
export function mockFetchNetworkError(spy: FetchSpy, message = 'Network error'): void {
  spy.mockRejectedValueOnce(new Error(message));
}
