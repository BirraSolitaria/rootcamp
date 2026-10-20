import { beforeEach, expect, test } from 'vitest';
import { dueItems } from '../src/leitner.js';
import {
  advanceReview,
  answerReviewTask,
  buildReviewSession,
  completeReview,
  currentReviewTaskId,
  dueTaskIdsInCourse,
  REVIEW_LIMIT,
  type ReviewSession,
} from '../src/reviewSession.js';
import type { Hearts, ReviewItems, Streak } from '../src/types.js';
import { makeTrack } from './helpers/makeTrack.js';

beforeEach(() => {
  expect.hasAssertions();
});

const tz = 'Europe/Moscow';
/** 2026-10-18 12:00 in Moscow (UTC+3). */
const T = Date.UTC(2026, 9, 18, 9, 0);
const today = '2026-10-18';
const { index } = makeTrack({ sections: 1, lessonsPerSection: 4, tasksPerLesson: 10 });
const lessonTaskIds = (lessonId: string) =>
  index.sections
    .get('t1.s01')!
    .lessons.find((l) => l.id === lessonId)!
    .tasks.map((t) => t.id);

/** Deterministic LCG in [0, 1). */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const base = {
  items: {} as ReviewItems,
  completedLessonIds: [] as string[],
  index,
  today,
  rng: seeded(1),
};

/** 12 due items with mixed due dates and boxes, all from l01/l02. */
function twelveDue(): ReviewItems {
  const ids = [...lessonTaskIds('t1.s01.l01'), ...lessonTaskIds('t1.s01.l02')].slice(0, 12);
  const items: ReviewItems = {};
  ids.forEach((id, i) => {
    items[id] = {
      taskId: id,
      box: ((i % 3) + 1) as 1 | 2 | 3,
      dueDate: `2026-10-${String(18 - (i % 4)).padStart(2, '0')}`,
    };
  });
  return items;
}

const streak0: Streak = { current: 2, best: 4, lastActivityDate: '2026-10-17' };
const hearts3: Hearts = { count: 3, lastRegenAt: T };
const ctx = { hearts: hearts3, streak: streak0, xpToday: 20, now: T, tz };

function finished(mode: 'review' | 'drill', correct: number, total: number): ReviewSession {
  return {
    mode,
    taskIds: lessonTaskIds('t1.s01.l01').slice(0, total),
    index: total,
    correct,
    status: 'completed',
    presentation: total,
  };
}

test('limit is 10', () => {
  expect(REVIEW_LIMIT).toBe(10);
});

test('review takes first min(10, due) in dueItems order', () => {
  const items = twelveDue();
  const s = buildReviewSession('review', { ...base, items })!;
  expect(s.taskIds).toHaveLength(10);
  expect(s.taskIds).toEqual(
    dueItems(items, today)
      .slice(0, 10)
      .map((i) => i.taskId),
  );
  expect(s).toMatchObject({
    mode: 'review',
    index: 0,
    correct: 0,
    status: 'in_progress',
    presentation: 0,
  });
  expect(currentReviewTaskId(s)).toBe(s.taskIds[0]);
});

test('review with fewer than 10 due takes all of them; future items excluded', () => {
  const [a, b, c] = lessonTaskIds('t1.s01.l01') as [string, string, string];
  const items: ReviewItems = {
    [a]: { taskId: a, box: 2, dueDate: '2026-10-18' },
    [b]: { taskId: b, box: 1, dueDate: '2026-10-15' },
    [c]: { taskId: c, box: 1, dueDate: '2026-10-19' },
  };
  expect(buildReviewSession('review', { ...base, items })!.taskIds).toEqual([b, a]);
});

test('review returns null when nothing due', () => {
  expect(buildReviewSession('review', { ...base, items: {} })).toBeNull();
  const [a] = lessonTaskIds('t1.s01.l01') as [string];
  expect(
    buildReviewSession('review', {
      ...base,
      items: { [a]: { taskId: a, box: 1, dueDate: '2026-10-19' } },
    }),
  ).toBeNull();
});

test('review ignores taskIds not in the loaded course', () => {
  const [a] = lessonTaskIds('t1.s01.l01') as [string];
  const gone = { taskId: 'gone', box: 1 as const, dueDate: '2026-10-01' };
  const items: ReviewItems = { gone, [a]: { taskId: a, box: 1, dueDate: '2026-10-18' } };
  expect(dueTaskIdsInCourse(items, index, today)).toEqual([a]);
  expect(buildReviewSession('review', { ...base, items })!.taskIds).toEqual([a]);
  expect(buildReviewSession('review', { ...base, items: { gone } })).toBeNull();
});

test('review and due counter exclude terminal_practice tasks', () => {
  const { index: ix } = makeTrack({ layout: [['L', 'inc-port-clash']], tasksPerLesson: 2 });
  const practiceTask = 't1.s01.p-inc-port-clash.t01';
  const items: ReviewItems = {
    [practiceTask]: { taskId: practiceTask, box: 1, dueDate: '2026-10-10' },
    't1.s01.l01.t01': { taskId: 't1.s01.l01.t01', box: 1, dueDate: today },
  };
  expect(dueTaskIdsInCourse(items, ix, today)).toEqual(['t1.s01.l01.t01']);
  expect(buildReviewSession('review', { ...base, index: ix, items })!.taskIds).toEqual([
    't1.s01.l01.t01',
  ]);
});

test('drill: 10 random tasks from completed lessons, all if fewer', () => {
  const ids = ['t1.s01.l01', 't1.s01.l02'];
  const pool = [...lessonTaskIds('t1.s01.l01'), ...lessonTaskIds('t1.s01.l02')];
  const s1 = buildReviewSession('drill', { ...base, completedLessonIds: ids, rng: seeded(1) })!;
  expect(s1.mode).toBe('drill');
  expect(s1.taskIds).toHaveLength(10);
  expect(new Set(s1.taskIds).size).toBe(10);
  expect(s1.taskIds.every((id) => pool.includes(id))).toBe(true);
  const s2 = buildReviewSession('drill', { ...base, completedLessonIds: ids, rng: seeded(99) })!;
  expect(s2.taskIds).not.toEqual(s1.taskIds);
  const s1again = buildReviewSession('drill', {
    ...base,
    completedLessonIds: ids,
    rng: seeded(1),
  })!;
  expect(s1again.taskIds).toEqual(s1.taskIds);

  const { index: small } = makeTrack({ sections: 1, lessonsPerSection: 2, tasksPerLesson: 6 });
  const six = small.sections.get('t1.s01')!.lessons[0]!.tasks.map((t) => t.id);
  const s3 = buildReviewSession('drill', {
    ...base,
    index: small,
    completedLessonIds: ['t1.s01.l01'],
  })!;
  expect(s3.taskIds).toHaveLength(6);
  expect([...s3.taskIds].sort()).toEqual([...six].sort());

  expect(buildReviewSession('drill', { ...base, completedLessonIds: [] })).toBeNull();
});

test('drill pool excludes terminal_practice tasks', () => {
  const { index: ix } = makeTrack({ layout: [['L', 'inc-port-clash']], tasksPerLesson: 3 });
  const s = buildReviewSession('drill', {
    ...base,
    index: ix,
    completedLessonIds: ['t1.s01.l01', 't1.s01.p-inc-port-clash'],
  })!;
  expect([...s.taskIds].sort()).toEqual(['t1.s01.l01.t01', 't1.s01.l01.t02', 't1.s01.l01.t03']);
  expect(
    buildReviewSession('drill', {
      ...base,
      index: ix,
      completedLessonIds: ['t1.s01.p-inc-port-clash'],
    }),
  ).toBeNull();
});

test('drill is refused while any due item exists', () => {
  const [a] = lessonTaskIds('t1.s01.l01') as [string];
  const items: ReviewItems = { [a]: { taskId: a, box: 1, dueDate: '2026-10-18' } };
  expect(
    buildReviewSession('drill', { ...base, items, completedLessonIds: ['t1.s01.l01'] }),
  ).toBeNull();
  const notDue: ReviewItems = { [a]: { taskId: a, box: 1, dueDate: '2026-10-19' } };
  expect(
    buildReviewSession('drill', { ...base, items: notDue, completedLessonIds: ['t1.s01.l01'] }),
  ).not.toBeNull();
});

test('review answers move boxes; drill correct does not', () => {
  const [a] = lessonTaskIds('t1.s01.l01') as [string];
  const items: ReviewItems = { [a]: { taskId: a, box: 1, dueDate: today } };
  const review = buildReviewSession('review', { ...base, items })!;
  const r = answerReviewTask(review, true, items, today);
  expect(r.items[a]).toEqual({ taskId: a, box: 2, dueDate: '2026-10-21' });
  expect(r.session.correct).toBe(1);
  expect(r.session.index).toBe(0);

  const rw = answerReviewTask(review, false, items, today);
  expect(rw.items[a]).toEqual({ taskId: a, box: 1, dueDate: '2026-10-19' });
  expect(rw.session.correct).toBe(0);

  const drill: ReviewSession = {
    mode: 'drill',
    taskIds: [a],
    index: 0,
    correct: 0,
    status: 'in_progress',
    presentation: 0,
  };
  const boxed: ReviewItems = { [a]: { taskId: a, box: 2, dueDate: '2026-10-20' } };
  const p = answerReviewTask(drill, true, boxed, today);
  expect(p.items).toEqual(boxed);
  expect(p.session.correct).toBe(1);
  const pw = answerReviewTask(drill, false, boxed, today);
  expect(pw.items[a]).toEqual({ taskId: a, box: 1, dueDate: '2026-10-19' });
  expect(pw.session.correct).toBe(0);
});

test('advanceReview walks to completion; current is null after the end', () => {
  const [a, b] = lessonTaskIds('t1.s01.l01') as [string, string];
  let s: ReviewSession = {
    mode: 'drill',
    taskIds: [a, b],
    index: 0,
    correct: 0,
    status: 'in_progress',
    presentation: 0,
  };
  s = advanceReview(s);
  expect(s).toMatchObject({ index: 1, presentation: 1, status: 'in_progress' });
  expect(currentReviewTaskId(s)).toBe(b);
  s = advanceReview(s);
  expect(s).toMatchObject({ index: 2, presentation: 2, status: 'completed' });
  expect(currentReviewTaskId(s)).toBeNull();
  expect(advanceReview(s)).toBe(s);
  expect(answerReviewTask(s, true, {}, today)).toEqual({ session: s, items: {} });
});

test('completeReview: xp = correct, +1 heart (max 5), streak, summary', () => {
  const d = completeReview({ ...ctx, session: finished('review', 7, 10) });
  expect(d).toEqual({
    xp: 7,
    hearts: { count: 4, lastRegenAt: T },
    streak: { current: 3, best: 4, lastActivityDate: today },
    summary: {
      kind: 'review',
      mode: 'review',
      correct: 7,
      total: 10,
      heartGained: true,
      xpGained: 7,
      xpToday: 27,
      dailyGoal: 30,
      goalJustReached: false,
      streak: 3,
      streakIncreased: true,
    },
  });

  const full = completeReview({
    ...ctx,
    hearts: { count: 5, lastRegenAt: T },
    session: finished('drill', 3, 6),
  });
  expect(full.hearts.count).toBe(5);
  expect(full.summary).toMatchObject({ mode: 'drill', heartGained: false, xpGained: 3, total: 6 });
});

test('completeReview: goal reached, same-day streak not increased, zero correct', () => {
  const sameDay: Streak = { current: 3, best: 4, lastActivityDate: today };
  const r = completeReview({
    ...ctx,
    streak: sameDay,
    xpToday: 25,
    session: finished('review', 5, 10),
  });
  expect(r.summary).toMatchObject({
    goalJustReached: true,
    xpToday: 30,
    streak: 3,
    streakIncreased: false,
  });
  expect(r.streak).toEqual(sameDay);

  const z = completeReview({ ...ctx, streak: sameDay, session: finished('drill', 0, 10) });
  expect(z.xp).toBe(0);
  expect(z.summary).toMatchObject({ xpGained: 0, correct: 0, heartGained: true });
  expect(z.hearts.count).toBe(4);
});

test('completeReview regenerates hearts before the +1', () => {
  const d = completeReview({
    ...ctx,
    hearts: { count: 3, lastRegenAt: T - 31 * 60_000 },
    session: finished('review', 1, 1),
  });
  expect(d.hearts.count).toBe(5);
  expect(d.summary.heartGained).toBe(true);
});

test('completeReview credits the calendar day of now in the user zone', () => {
  // 2026-10-19 00:03 in Moscow, still 2026-10-18 in UTC.
  const now = Date.UTC(2026, 9, 18, 21, 3);
  const streak: Streak = { current: 1, best: 1, lastActivityDate: today };
  const d = completeReview({ ...ctx, streak, xpToday: 0, now, session: finished('review', 2, 2) });
  expect(d.streak).toEqual({ current: 2, best: 2, lastActivityDate: '2026-10-19' });
});

test('inputs are not mutated', () => {
  const items = twelveDue();
  const snapshot = JSON.parse(JSON.stringify(items));
  const ctxSnap = JSON.parse(JSON.stringify(ctx));
  const s = buildReviewSession('review', { ...base, items })!;
  answerReviewTask(s, true, items, today);
  completeReview({ ...ctx, session: finished('review', 7, 10) });
  expect(items).toEqual(snapshot);
  expect(ctx).toEqual(ctxSnap);
});

test('completeReview on an unfinished session grants nothing and keeps state', () => {
  const s: ReviewSession = { ...finished('review', 3, 10), index: 3, status: 'in_progress' };
  const d = completeReview({ ...ctx, session: s });
  expect(d.xp).toBe(0);
  expect(d.hearts).toBe(ctx.hearts);
  expect(d.streak).toBe(ctx.streak);
  expect(d.summary).toEqual({
    kind: 'review',
    mode: 'review',
    correct: 3,
    total: 10,
    heartGained: false,
    xpGained: 0,
    xpToday: 20,
    dailyGoal: 30,
    goalJustReached: false,
    streak: 2,
    streakIncreased: false,
  });
});
