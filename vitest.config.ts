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
    },
    projects: [
      {
        // Unit tests: pure domain functions, config validation.
        // No database, no Fastify — safe to run files in parallel.
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'src/config/__tests__/**/*.test.ts',
            'src/domain/__tests__/**/*.test.ts',
            'src/state/__tests__/**/*.test.ts',
          ],
        },
      },
      {
        // Component tests: React components and hooks with React Testing
        // Library, under jsdom. No network, no database — stores and
        // API client are stubbed per-file.
        extends: true,
        test: {
          name: 'component',
          environment: 'jsdom',
          include: [
            'src/ui/**/__tests__/**/*.test.{ts,tsx}',
            'src/hooks/**/__tests__/**/*.test.{ts,tsx}',
          ],
          setupFiles: ['src/test/component-setup.ts'],
        },
      },
      {
        // Integration tests: per-process PostgreSQL database, Fastify
        // server. The setupFile creates `projekt_manager_test_<pid>` and
        // overrides DATABASE_URL before any test imports — so two
        // parallel runs (different worktrees, different agents) cannot
        // race each other's seed TRUNCATE. Files within one fork still
        // run sequentially to keep audit-publisher state coherent.
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          fileParallelism: false,
          setupFiles: ['src/test/integration-setup.ts'],
          globalSetup: ['src/test/integration-globalsetup.ts'],
          include: ['src/server/__tests__/**/*.test.ts'],
        },
      },
    ],
  },
});
