import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import path from 'path';

/**
 * Strip data-testid attributes from JSX during production builds.
 * Prevents shipping a DOM map to production.
 */
function stripTestAttributes(): Plugin {
  return {
    name: 'strip-test-attributes',
    apply: 'build',
    transform(code, id) {
      if (!/\.[jt]sx$/.test(id)) return null;
      return {
        code: code.replace(/\s+data-testid(?:=(?:"[^"]*"|'[^']*'|\{[^}]*\}))?/g, ''),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), stripTestAttributes()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Force Vite to resolve and bundle all dependencies when the dev server
  // starts, rather than on the first browser request. Without this, the
  // first cold-start hit triggers "Re-optimizing dependencies" mid-test
  // and delays the landing view render by 10–15 s, causing flaky timeouts
  // in Playwright's auth setup (`e2e/auth.setup.ts`).
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    // Listen on all interfaces so the dev server is reachable via the
    // machine's IP address — needed for E2E tests that verify the
    // insecure-connection banner (which triggers on non-localhost HTTP).
    // Consistent with the Fastify backend which already binds to 0.0.0.0.
    host: true,
    // `VITE_DEV_PORT` / `VITE_API_PROXY_TARGET` let Playwright spawn
    // an isolated client + backend on non-default ports without
    // colliding with a developer's running dev server. Without the
    // isolation, `npx playwright test` and `npm run dev` share one
    // database (and one API), producing races that show up as
    // intermittent "visual regression" / "missing data" failures.
    // See playwright.config.ts `webServer` for the paired override.
    //
    // `strictPort: true` is important under Playwright: if 5174 is
    // already in use (e.g. two E2E runs overlap) vite would silently
    // pick the next free port, and Playwright would wait for the
    // configured URL to answer until it times out.
    port: Number(process.env.VITE_DEV_PORT) || 5173,
    strictPort: Boolean(process.env.VITE_DEV_PORT),
    proxy: {
      '/api': process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
    },
  },
});
