import { defineConfig } from 'vitest/config';

// Catch leaks of the local time zone: tests must pass explicit IANA zones.
process.env.TZ = 'UTC';

// Resolve workspace packages to their TypeScript sources (`rootcamp-src` in their
// package.json exports) instead of the built dist/. Tests run in vitest's node
// environment, which resolves through the SSR options; the rest are Vite's defaults.
const conditions = ['rootcamp-src', 'module', 'node', 'development|production'];

export default defineConfig({
  ssr: { resolve: { conditions } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
