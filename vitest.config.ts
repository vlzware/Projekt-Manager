import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.claude/**'],
    // Server integration tests share a PostgreSQL database and mutate
    // shared state (user passwords, deactivations, project transitions).
    // Running them in parallel causes race conditions.
    fileParallelism: false,
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
      },
    },
  },
});
