import { defineConfig } from 'vitest/config';

// Catch leaks of the local time zone: tests must pass explicit IANA zones.
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 95 },
    },
  },
});
