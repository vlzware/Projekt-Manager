/**
 * Unit tests for the static-asset Cache-Control helper.
 *
 * Without explicit policy, @fastify/static (via send) emits
 * `cache-control: public, max-age=0` — forcing revalidation on every load.
 * This helper assigns three tiers based on path; the tests pin that behavior
 * so a future refactor of static-serving cannot silently regress it.
 */

import { describe, it, expect } from 'vitest';
import { staticCacheControl } from '../staticCache.js';

describe('staticCacheControl', () => {
  it('returns 1y immutable for hashed bundles under /assets/', () => {
    expect(staticCacheControl('/srv/dist/assets/index-BQecmQ3Z.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(staticCacheControl('/srv/dist/assets/index-BbWcRZwX.css')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(staticCacheControl('/srv/dist/assets/eruda-D8duJ7ZY.js')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('returns no-cache for index.html (pins hashed asset names)', () => {
    expect(staticCacheControl('/srv/dist/index.html')).toBe('no-cache');
  });

  it('returns no-cache for sw.js so SW updates propagate on deploy', () => {
    expect(staticCacheControl('/srv/dist/sw.js')).toBe('no-cache');
  });

  it('returns 1 day for PWA icons', () => {
    expect(staticCacheControl('/srv/dist/icons/icon-192.png')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/icons/icon-512.png')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/icons/icon-maskable-512.png')).toBe(
      'public, max-age=86400',
    );
  });

  it('returns 1 day for top-level static files (favicon, manifest, theme-init)', () => {
    expect(staticCacheControl('/srv/dist/favicon.svg')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/favicon-maskable.svg')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/manifest.webmanifest')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/theme-init.js')).toBe('public, max-age=86400');
  });
});
