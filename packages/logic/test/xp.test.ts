import { beforeEach, expect, test } from 'vitest';
import {
  DAILY_GOAL,
  goalJustReached,
  LESSON_XP,
  lessonXp,
  PERFECT_BONUS,
  weekBars,
} from '../src/xp.js';

beforeEach(() => {
  expect.hasAssertions();
});

test('constants', () => {
  expect(LESSON_XP).toBe(10);
  expect(PERFECT_BONUS).toBe(5);
  expect(DAILY_GOAL).toBe(30);
});
test('lesson xp', () => {
  expect(lessonXp(0)).toBe(15);
  expect(lessonXp(2)).toBe(10);
});
test('goalJustReached', () => {
  expect(goalJustReached(25, 35, 30)).toBe(true);
  expect(goalJustReached(30, 40, 30)).toBe(false);
  expect(goalJustReached(10, 20, 30)).toBe(false);
});
test('weekBars', () => {
  const b = weekBars({ '2026-10-18': 60, '2026-10-12': 15 }, '2026-10-18', 30);
  expect(b).toHaveLength(7);
  expect(b[0]).toMatchObject({ key: '2026-10-12', label: 'Пн', xp: 15, ratio: 0.25 });
  expect(b[6]).toMatchObject({ label: 'Вс', ratio: 1 });
  expect(weekBars({}, '2026-10-18', 30)[6]?.ratio).toBe(0);
  expect(weekBars({}, '2026-10-18', 0)[6]?.ratio).toBe(0);
});
