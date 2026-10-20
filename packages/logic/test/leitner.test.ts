import { beforeEach, expect, test } from 'vitest';
import { dueItems, INTERVAL, markCorrectInReview, markWrong } from '../src/leitner.js';
import type { ReviewItems } from '../src/types.js';

beforeEach(() => {
  expect.hasAssertions();
});

const today = '2026-10-18';

test('intervals', () => {
  expect(INTERVAL).toEqual({ 1: 1, 2: 3, 3: 7 });
});
test('wrong → box 1, +1 day; overwrites', () => {
  expect(markWrong({}, 't', today)).toEqual({ t: { taskId: 't', box: 1, dueDate: '2026-10-19' } });
  expect(markWrong({ t: { taskId: 't', box: 3, dueDate: '2026-10-01' } }, 't', today).t?.box).toBe(
    1,
  );
});
test('correct moves 1→2 (+3), 2→3 (+7), 3→removed', () => {
  expect(markCorrectInReview({ t: { taskId: 't', box: 1, dueDate: today } }, 't', today).t).toEqual(
    { taskId: 't', box: 2, dueDate: '2026-10-21' },
  );
  expect(markCorrectInReview({ t: { taskId: 't', box: 2, dueDate: today } }, 't', today).t).toEqual(
    { taskId: 't', box: 3, dueDate: '2026-10-25' },
  );
  expect(markCorrectInReview({ t: { taskId: 't', box: 3, dueDate: today } }, 't', today)).toEqual(
    {},
  );
});
test('correct on absent taskId is a no-op', () => {
  const items: ReviewItems = { a: { taskId: 'a', box: 1, dueDate: today } };
  expect(markCorrectInReview(items, 'zzz', today)).toEqual(items);
});
test('inputs are not mutated and new objects are returned', () => {
  const items: ReviewItems = { t: { taskId: 't', box: 1, dueDate: today } };
  const snapshot = JSON.parse(JSON.stringify(items));
  const w = markWrong(items, 'u', today);
  const c = markCorrectInReview(items, 't', today);
  const r = markCorrectInReview({ t: { taskId: 't', box: 3, dueDate: today } }, 't', today);
  expect(items).toEqual(snapshot);
  expect(w).not.toBe(items);
  expect(c).not.toBe(items);
  expect(r).toEqual({});
});
test('dueItems order and filtering', () => {
  const items: ReviewItems = {
    b: { taskId: 'b', box: 2, dueDate: '2026-10-17' },
    c: { taskId: 'c', box: 1, dueDate: '2026-10-17' },
    a: { taskId: 'a', box: 3, dueDate: '2026-10-16' },
    d: { taskId: 'd', box: 1, dueDate: '2026-10-18' },
    e: { taskId: 'e', box: 1, dueDate: '2026-10-19' },
  };
  expect(dueItems(items, today).map((i) => i.taskId)).toEqual(['a', 'c', 'b', 'd']);
});
test('dueItems ties broken by taskId', () => {
  const items: ReviewItems = {
    z: { taskId: 'z', box: 1, dueDate: today },
    m: { taskId: 'm', box: 1, dueDate: today },
  };
  expect(dueItems(items, today).map((i) => i.taskId)).toEqual(['m', 'z']);
  expect(dueItems({}, today)).toEqual([]);
});
