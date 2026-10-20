import { beforeEach, expect, test } from 'vitest';
import { toDateKey } from '../src/dates.js';
import { checkStreakBroken, registerActivity } from '../src/streak.js';

beforeEach(() => {
  expect.hasAssertions();
});

test('first activity → 1', () =>
  expect(registerActivity({ current: 0, best: 0, lastActivityDate: null }, '2026-10-10')).toEqual({
    current: 1,
    best: 1,
    lastActivityDate: '2026-10-10',
  }));
test('next day +1', () =>
  expect(
    registerActivity({ current: 1, best: 1, lastActivityDate: '2026-10-10' }, '2026-10-11').current,
  ).toBe(2));
test('same day unchanged', () => {
  const s = { current: 2, best: 5, lastActivityDate: '2026-10-11' };
  expect(registerActivity(s, '2026-10-11')).toEqual(s);
});
test('gap → 1 on activity, 0 on check', () => {
  const s = { current: 2, best: 2, lastActivityDate: '2026-10-11' };
  expect(checkStreakBroken(s, '2026-10-13')).toEqual({
    current: 0,
    best: 2,
    lastActivityDate: '2026-10-11',
  });
  expect(registerActivity(checkStreakBroken(s, '2026-10-13'), '2026-10-13')).toEqual({
    current: 1,
    best: 2,
    lastActivityDate: '2026-10-13',
  });
  expect(checkStreakBroken(s, '2026-10-12')).toEqual(s);
});
test('23:59 then 00:01 next day → +1', () => {
  // Europe/Berlin, CEST (UTC+2): 2026-10-10 23:59 and 2026-10-11 00:01 local.
  const d1 = toDateKey(Date.UTC(2026, 9, 10, 21, 59), 'Europe/Berlin');
  const d2 = toDateKey(Date.UTC(2026, 9, 10, 22, 1), 'Europe/Berlin');
  const s1 = registerActivity({ current: 0, best: 0, lastActivityDate: null }, d1);
  expect(s1).toEqual({ current: 1, best: 1, lastActivityDate: '2026-10-10' });
  expect(registerActivity(s1, d2)).toEqual({ current: 2, best: 2, lastActivityDate: '2026-10-11' });
});
test('date before last → unchanged', () => {
  const s = { current: 3, best: 3, lastActivityDate: '2026-10-11' };
  expect(registerActivity(s, '2026-10-09')).toEqual(s);
});
test('best grows, never drops', () => {
  expect(
    registerActivity({ current: 4, best: 4, lastActivityDate: '2026-10-10' }, '2026-10-11').best,
  ).toBe(5);
  expect(
    registerActivity({ current: 2, best: 7, lastActivityDate: '2026-10-08' }, '2026-10-11'),
  ).toEqual({ current: 1, best: 7, lastActivityDate: '2026-10-11' });
});
test('checkStreakBroken with no activity → unchanged', () => {
  const s = { current: 0, best: 0, lastActivityDate: null };
  expect(checkStreakBroken(s, '2026-10-18')).toEqual(s);
});
