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
      '@ingestion': resolve('packages/ingestion/src')
    }
  },
  test: {
    environment: 'node',
    include: ['scripts/benchmark-local-capacity.test.ts']
  }
});
