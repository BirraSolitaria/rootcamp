import { beforeEach, expect, test } from 'vitest';
import { addDays, diffDays, isDateKey, localTimeOn, toDateKey } from '../src/dates.js';

beforeEach(() => {
  expect.hasAssertions();
});

// DockerLingo ran these under TZ=Europe/Berlin (CEST = UTC+2 in October); the zone is now explicit.
test('toDateKey around midnight', () => {
  expect(toDateKey(Date.UTC(2026, 9, 18, 21, 59, 59), 'Europe/Berlin')).toBe('2026-10-18');
  expect(toDateKey(Date.UTC(2026, 9, 18, 22, 0, 1), 'Europe/Berlin')).toBe('2026-10-19');
});

test('diffDays across DST switch 2026-03-29', () => {
  expect(diffDays('2026-03-28', '2026-03-30')).toBe(2);
  expect(diffDays('2026-03-29', '2026-03-29')).toBe(0);
  expect(diffDays('2026-03-30', '2026-03-28')).toBe(-2);
});

test('addDays across month and year end', () => {
  expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
});

test('localTimeOn', () => {
  // 2026-03-29 is the CET→CEST switch day; 20:00 CEST = 18:00 UTC.
  expect(localTimeOn('2026-03-29', 20, 0, 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 18, 0));
});

test('isDateKey', () => {
  expect(isDateKey('2026-10-18')).toBe(true);
  expect(isDateKey('2026-1-8')).toBe(false);
  expect(isDateKey(5)).toBe(false);
});
