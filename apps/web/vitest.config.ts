import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (`rootcamp-src` in their
// package.json exports). Tests run in jsdom, which resolves through the client options.
const conditions = ['rootcamp-src', 'module', 'browser', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
