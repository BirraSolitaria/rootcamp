import { beforeEach, expect, test } from 'vitest';
import { computeRank, maxRank, nextRankProgress, RANK_ORDER } from '../src/rank.js';

beforeEach(() => {
  expect.hasAssertions();
});

test('rank order', () => {
  expect(RANK_ORDER).toEqual(['guest', 'user', 'sudoer', 'root']);
});

test('computeRank thresholds', () => {
  expect(computeRank(0, 0)).toBe('guest');
  expect(computeRank(199, 0)).toBe('guest');
  expect(computeRank(200, 0)).toBe('user');
  expect(computeRank(1500, 0)).toBe('user');
  expect(computeRank(1500, 1)).toBe('sudoer');
  expect(computeRank(6000, 3)).toBe('sudoer');
  expect(computeRank(6000, 4)).toBe('root');
  // tracks without XP do not lift the rank
  expect(computeRank(199, 4)).toBe('guest');
});

test('maxRank', () => {
  expect(maxRank('sudoer', 'user')).toBe('sudoer');
  expect(maxRank('user', 'sudoer')).toBe('sudoer');
  expect(maxRank('guest', 'guest')).toBe('guest');
  expect(maxRank('root', 'guest')).toBe('root');
});

test('nextRankProgress', () => {
  expect(nextRankProgress(1600, 0)).toEqual({ next: 'sudoer', xpNeeded: 0, tracksNeeded: 1 });
  expect(nextRankProgress(50, 0)).toEqual({ next: 'user', xpNeeded: 150, tracksNeeded: 0 });
  expect(nextRankProgress(1000, 2)).toEqual({ next: 'sudoer', xpNeeded: 500, tracksNeeded: 0 });
  expect(nextRankProgress(2000, 1)).toEqual({ next: 'root', xpNeeded: 4000, tracksNeeded: 3 });
  expect(nextRankProgress(6000, 4)).toEqual({ next: null, xpNeeded: 0, tracksNeeded: 0 });
});
