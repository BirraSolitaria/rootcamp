import { expect, test } from 'vitest';
import { parsePort } from '../src/config.js';

test('parsePort defaults to 3000 when PORT is unset or empty', () => {
  expect(parsePort(undefined)).toBe(3000);
  expect(parsePort('')).toBe(3000);
});

test('parsePort accepts a decimal TCP port', () => {
  expect(parsePort('8080')).toBe(8080);
  expect(parsePort(' 3001 ')).toBe(3001);
  expect(parsePort('0')).toBe(0);
  expect(parsePort('65535')).toBe(65535);
});

test.each(['abc', '30a0', '3000.5', '-1', '65536', '0x10', '1e3'])(
  'parsePort rejects %j with a clear error',
  (value) => {
    expect(() => parsePort(value)).toThrow(`PORT must be an integer 0-65535, got "${value}"`);
  },
);
