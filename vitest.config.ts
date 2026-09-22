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
    // Windows CI 的冷启动 PDF/DOCX 转换与 SQLite 用例会超过 Vitest 默认 5 秒；不放宽其他平台。
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    include: ['packages/**/*.test.ts', 'apps/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: ['scripts/benchmark-local-capacity.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage'
    }
  }
});
