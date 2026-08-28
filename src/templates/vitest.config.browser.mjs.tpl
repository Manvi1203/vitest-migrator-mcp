import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser/providers/playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      name: 'chromium',
      headless: true
    },
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.node.test.ts'
    ],
    testTimeout: 20000,
    hookTimeout: 20000
  },
  resolve: {
    alias: {
      '@firebase/app': path.resolve(__dirname, '../app/src/index.ts')
    }
  }
});
