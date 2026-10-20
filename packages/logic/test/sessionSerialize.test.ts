import { beforeEach, expect, test } from 'vitest';
import {
  answerLessonTask,
  beginTasks,
  startLesson,
  type LessonSession,
} from '../src/lessonSession.js';
import { advanceReview, answerReviewTask, buildReviewSession } from '../src/reviewSession.js';
import type { ReviewItems } from '../src/types.js';
import { makeTrack } from './helpers/makeTrack.js';

beforeEach(() => {
  expect.hasAssertions();
});

const tz = 'UTC';
const T = Date.UTC(2026, 9, 18, 12, 0);
const { index } = makeTrack({ sections: 1, lessonsPerSection: 2, tasksPerLesson: 4 });

test('lesson session survives a JSON round trip after two answers', () => {
  const lesson = index.sections.get('t1.s01')!.lessons[0]!;
  const started = startLesson(lesson, { count: 5, lastRegenAt: T }, T);
  if (!started.ok) throw new Error('expected start');
  let s: LessonSession = beginTasks(started.session);
  let hearts = started.hearts;
  let items: ReviewItems = {};
  ({ session: s, hearts, items } = answerLessonTask(s, true, { hearts, items, now: T, tz }));
  ({ session: s, hearts, items } = answerLessonTask(s, false, { hearts, items, now: T, tz }));
  expect(s.solved).toEqual(['t1.s01.l01.t01']);
  expect(s.mistakes).toBe(1);
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
});

test('review session survives a JSON round trip', () => {
  const s = buildReviewSession('drill', {
    items: {},
    completedLessonIds: ['t1.s01.l01'],
    index,
    today: '2026-10-18',
    rng: () => 0.5,
  })!;
  const after = advanceReview(answerReviewTask(s, true, {}, '2026-10-18').session);
  expect(JSON.parse(JSON.stringify(after))).toEqual(after);
});
