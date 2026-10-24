import { describe, expect, test } from 'vitest';
import { checkOutput, clipChars } from '../src/lifecycle.js';
import { usageMinutes } from '../src/usage.js';

describe('usageMinutes', () => {
  const ready = new Date('2026-10-20T09:00:00Z');
  test('rounds up to whole minutes', () => {
    expect(usageMinutes(ready, new Date(ready.getTime() + 1))).toBe(1);
    expect(usageMinutes(ready, new Date(ready.getTime() + 60_000))).toBe(1);
    expect(usageMinutes(ready, new Date(ready.getTime() + 60_001))).toBe(2);
  });
  test('never negative', () => {
    expect(usageMinutes(ready, ready)).toBe(0);
    expect(usageMinutes(ready, new Date(ready.getTime() - 5000))).toBe(0);
  });
});

describe('clipChars / checkOutput', () => {
  test('keeps at most n UTF-16 units without splitting a surrogate pair', () => {
    expect(clipChars('abc', 2)).toBe('ab');
    expect(clipChars('a😀', 2)).toBe('a');
    expect(clipChars('a😀', 3)).toBe('a😀');
    expect(clipChars('x'.repeat(1000), 300)).toHaveLength(300);
  });
  test('a timed-out check reports the limit instead of its output', () => {
    expect(checkOutput({ exitCode: 124, output: 'partial', timedOut: true }, 7)).toBe(
      'проверка не уложилась в 7 с',
    );
    expect(checkOutput({ exitCode: 1, output: 'nginx -t fails', timedOut: false }, 7)).toBe(
      'nginx -t fails',
    );
  });
});
