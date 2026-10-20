import { expect, test } from 'vitest';

test('package entry point loads', async () => {
  expect(await import('../src/index.js')).toBeDefined();
});
