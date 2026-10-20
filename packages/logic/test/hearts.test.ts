import { beforeEach, expect, test } from 'vitest';
import { gainHeart, loseHeart, MAX_HEARTS, msToNextHeart, regen, REGEN_MS } from '../src/hearts.js';

beforeEach(() => {
  expect.hasAssertions();
});

const T = Date.UTC(2026, 9, 18, 10, 0);
const M = 60_000;

test('constants', () => {
  expect(MAX_HEARTS).toBe(5);
  expect(REGEN_MS).toBe(1_800_000);
});
test('4 + 29min → 4', () =>
  expect(regen({ count: 4, lastRegenAt: T }, T + 29 * M)).toEqual({ count: 4, lastRegenAt: T }));
test('4 + 30min → 5, anchor=now', () =>
  expect(regen({ count: 4, lastRegenAt: T }, T + 30 * M)).toEqual({
    count: 5,
    lastRegenAt: T + 30 * M,
  }));
test('2 + 95min → 5, no carry-over', () =>
  expect(regen({ count: 2, lastRegenAt: T }, T + 95 * M)).toEqual({
    count: 5,
    lastRegenAt: T + 95 * M,
  }));
test('1 + 65min → 3, anchor +60min', () =>
  expect(regen({ count: 1, lastRegenAt: T }, T + 65 * M)).toEqual({
    count: 3,
    lastRegenAt: T + 60 * M,
  }));
test('full stays full, anchor=now', () =>
  expect(regen({ count: 5, lastRegenAt: T }, T + M)).toEqual({ count: 5, lastRegenAt: T + M }));
test('loseHeart at 5 anchors to now', () =>
  expect(loseHeart({ count: 5, lastRegenAt: T - 600 * M }, T)).toEqual({
    count: 4,
    lastRegenAt: T,
  }));
test('loseHeart never below 0', () =>
  expect(loseHeart({ count: 0, lastRegenAt: T }, T + M).count).toBe(0));
test('clock moved back', () =>
  expect(regen({ count: 3, lastRegenAt: T }, T - 5 * M)).toEqual({
    count: 3,
    lastRegenAt: T - 5 * M,
  }));
test('msToNextHeart', () => {
  expect(msToNextHeart({ count: 3, lastRegenAt: T }, T + 10 * M)).toBe(20 * M);
  expect(msToNextHeart({ count: 5, lastRegenAt: T }, T)).toBeNull();
  expect(msToNextHeart({ count: 3, lastRegenAt: T }, T - M)).toBe(REGEN_MS);
});
test('gainHeart caps at 5', () => {
  expect(gainHeart({ count: 5, lastRegenAt: T }, T + M)).toEqual({ count: 5, lastRegenAt: T + M });
  expect(gainHeart({ count: 4, lastRegenAt: T }, T + M)).toEqual({ count: 5, lastRegenAt: T + M });
  expect(gainHeart({ count: 2, lastRegenAt: T }, T + M)).toEqual({ count: 3, lastRegenAt: T });
});
