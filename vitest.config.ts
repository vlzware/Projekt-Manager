import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Load all .env vars (empty prefix = no filter) so process.env
// has POSTGRES_PASSWORD etc. for server integration tests.
const env = loadEnv('test', process.cwd(), '');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    exclude: ['e2e/**', 'node_modules/**', '.claude/**'],
    env,
    css: {
      modules: {
        classNameStrategy: 'non-scoped',
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: {
        'src/domain/**': { statements: 80 },
        'src/config/**': { statements: 80 },
        'src/server/**': { statements: 70 },
        'src/state/**': { statements: 60 },
        'src/hooks/**': { statements: 60 },
      },
    },
    projects: [
      {
        // Unit + component tests: pure functions, React components, mocked APIs.
        // No database, no Fastify — safe to run files in parallel.
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: [
            'src/domain/__tests__/**/*.test.ts',
            'src/ui/__tests__/**/*.test.{ts,tsx}',
            'src/ui/*/__tests__/**/*.test.ts',
            'src/state/__tests__/**/*.test.ts',
            'src/hooks/__tests__/**/*.test.{ts,tsx}',
            'src/api/__tests__/**/*.test.ts',
          ],
        },
      },
      {
        // Integration tests: shared PostgreSQL database, Fastify server.
        // Files run sequentially to prevent seed/mutation race conditions.
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          fileParallelism: false,
          include: ['src/server/__tests__/**/*.test.ts'],
        },
      },
    ],
  },
});
