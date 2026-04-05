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
});
