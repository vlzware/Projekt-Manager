/**
 * Cache-Control policy for static assets served from the Vite build.
 *
 * Tiers:
 *   - /assets/*           → 1 year immutable (Vite content-hashes filenames)
 *   - index.html, sw.js   → no-cache (must revalidate so updates propagate)
 *   - everything else     → 1 day (icons, favicon, manifest, theme-init.js)
 *
 * index.html pins the hashed asset names, so caching it would defeat the
 * 1-year immutable bundle policy. sw.js controls push and notification
 * behavior; browsers cap SW max-age at 24h regardless, but no-cache makes
 * deploys propagate as soon as the next page navigation revalidates.
 *
 * Without this, @fastify/static defaults to `cache-control: public, max-age=0`,
 * which forces every page load and PWA install to revalidate every asset.
 */
export function staticCacheControl(filePath: string): string {
  if (filePath.includes('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (filePath.endsWith('/index.html') || filePath.endsWith('/sw.js')) {
    return 'no-cache';
  }
  return 'public, max-age=86400';
}
