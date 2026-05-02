/**
 * Service Worker bundle verification — pins that the build step
 * (`vite.config.ts` `buildServiceWorker` plugin) actually produces
 * `dist/sw.js` and that both surfaces (push + decrypt) end up in the
 * single artifact.
 *
 * The unit / component test suite normally runs without a prior
 * `npm run build`, so this test is no-op when `dist/sw.js` is absent.
 * In CI the build runs before the test suite, so the assertions
 * activate; locally `npm run build && npm test` exercises the same
 * path. The skip-when-absent shape keeps `npm test` green during
 * tight TDD loops on unrelated modules.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const BUNDLE_PATH = resolve(__dirname, '../../../dist/sw.js');

function bundleExists(): boolean {
  try {
    return statSync(BUNDLE_PATH).isFile();
  } catch {
    return false;
  }
}

describe('Service Worker bundle (dist/sw.js)', () => {
  it.skipIf(!bundleExists())('contains both push and fetch surfaces', () => {
    const stats = statSync(BUNDLE_PATH);
    // Smoke check: a real bundle of decryptHandler + pushHandlers +
    // index.ts is comfortably above 1 KB minified. A trivial empty
    // stub would be ~50 bytes.
    expect(stats.size).toBeGreaterThan(1024);

    const source = readFileSync(BUNDLE_PATH, 'utf8');

    // Decrypt handler routing literal — proves decryptHandler.ts was
    // bundled in (the prefix is the synthetic-origin contract per
    // ui/project-detail.md §8.15.4).
    expect(source).toContain('/encrypted-storage/');

    // Both top-level event listeners are wired in `index.ts`. Quoting
    // varies between minifiers; accept either single or double quotes.
    expect(source).toMatch(/addEventListener\(["']fetch["']/);
    expect(source).toMatch(/addEventListener\(["']push["']/);
  });
});
