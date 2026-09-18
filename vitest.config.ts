import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@contracts': resolve('packages/contracts/src'),
      '@core': resolve('packages/health-core/src'),
      '@storage': resolve('packages/storage/src'),
      '@workflow': resolve('packages/workflow/src'),
      '@codex': resolve('packages/codex-adapter/src'),
      '@ingestion': resolve('packages/ingestion/src'),
      '@renderer': resolve('apps/desktop/src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage'
    }
  }
});
