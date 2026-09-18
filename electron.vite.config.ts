import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
    build: {
      rollupOptions: {
        input: resolve('apps/desktop/src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('apps/desktop/src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.js'
        }
      }
    }
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('apps/desktop/src/renderer/src'),
        '@contracts': resolve('packages/contracts/src'),
        '@core': resolve('packages/health-core/src')
      }
    },
    build: {
      rollupOptions: {
        input: resolve('apps/desktop/src/renderer/index.html')
      }
    }
  }
});
