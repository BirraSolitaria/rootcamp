import { expect, test } from 'vitest';
import { normalize, normalizeKey } from '../src/index.js';

test('normalize', () => {
  expect(normalize('  Docker   RUN ')).toBe('docker run');
  expect(normalize('docker\t\nrun')).toBe('docker run');
  expect(normalizeKey('Что такое «образ»?')).toBe('что такое образ');
  expect(normalizeKey('Флаг : -d ? ')).toBe('флаг -d');
});
