import '@testing-library/jest-dom';
import { vi, afterEach, beforeEach } from 'vitest';

// Default fetch mock for component tests. The store now routes mutations
// through the API (iteration 2). Tests that need specific fetch behavior
// (e.g. auth.test.tsx) override this with vi.spyOn(globalThis, 'fetch').
beforeEach(() => {
  if (!vi.isMockFunction(globalThis.fetch)) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// jsdom does not implement matchMedia — polyfill for responsive tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
