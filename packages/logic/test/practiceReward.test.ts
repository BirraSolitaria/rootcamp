import { beforeEach, expect, test } from 'vitest';
import { PRACTICE_REPEAT_XP, practiceXp } from '../src/practiceReward.js';

beforeEach(() => {
  expect.hasAssertions();
});

const reward = { base: 40, noHintBonus: 10, hintCost: 5 };

test('repeat constant', () => {
  expect(PRACTICE_REPEAT_XP).toBe(10);
});

test('first solve: base + no-hint bonus, minus hint cost', () => {
  expect(practiceXp(reward, 0, true)).toBe(50);
  expect(practiceXp(reward, 1, true)).toBe(35);
  expect(practiceXp(reward, 2, true)).toBe(30);
});

test('first solve never goes below zero', () => {
  expect(practiceXp(reward, 20, true)).toBe(0);
});

test('repeat solve gives flat XP regardless of hints', () => {
  expect(practiceXp(reward, 0, false)).toBe(10);
  expect(practiceXp(reward, 3, false)).toBe(10);
});
