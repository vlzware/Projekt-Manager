import '@testing-library/jest-dom';
import { vi, afterEach, beforeEach } from 'vitest';

// Default fetch mock for component tests. Any test that calls fetch without
// first configuring its own spy will fail loudly with the message below.
//
// History: this used to silently return 200 with `{}`. The Wave 2 adversarial
// audit found that default made component mutation tests trivially pass
// without actually exercising the API integration — a click would fire, the
// store would call projectApi, fetch would return an empty success, and the
// optimistic local-state change would be treated as proof that the mutation
// worked. The fix is to fail loudly so every test is forced to declare
// exactly which fetch responses its scenario expects. See
// src/ui/__tests__/auth.test.tsx for the reference pattern.
beforeEach(() => {
  if (!vi.isMockFunction(globalThis.fetch)) {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Test tried to call fetch without configuring a mock response. ' +
              'This used to silently return 200 with {} — the audit found that ' +
              'made component mutation tests trivially pass without exercising ' +
              'the API integration. Use vi.spyOn(globalThis, "fetch") with ' +
              'mockResolvedValue / mockRejectedValue in your beforeEach or per ' +
              'test, following the src/ui/__tests__/auth.test.tsx pattern.',
          ),
        ),
    );
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// jsdom does not implement matchMedia — polyfill for responsive tests.
// Narrow-screen by default (matches: false); responsive tests that need a
// different breakpoint must override this, see useCollapseTier.test.ts.
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
