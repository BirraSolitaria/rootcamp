import { beforeEach, expect, test } from 'vitest';
import {
  answerLessonTask,
  beginTasks,
  completeLesson,
  continueLesson,
  currentTaskId,
  startLesson,
  type LessonSession,
} from '../src/lessonSession.js';
import type { Hearts, ReviewItems, Streak } from '../src/types.js';
import { makeTrack } from './helpers/makeTrack.js';

beforeEach(() => {
  expect.hasAssertions();
});

const tz = 'Europe/Moscow';
/** 2026-10-18 12:00 in Moscow (UTC+3). */
const T = Date.UTC(2026, 9, 18, 9, 0);
const M = 60_000;

const { index } = makeTrack({ sections: 1, lessonsPerSection: 4, tasksPerLesson: 10 });
const lesson = index.sections.get('t1.s01')!.lessons[0]!;
const start = startLesson(lesson, { count: 5, lastRegenAt: T }, T) as Extract<
  ReturnType<typeof startLesson>,
  { ok: true }
>;
const noStreak: Streak = { current: 0, best: 0, lastActivityDate: null };

/** Answers the current task and presses «Продолжить». */
function step(s: LessonSession, correct: boolean, hearts: Hearts, items: ReviewItems, now: number) {
  const a = answerLessonTask(s, correct, { hearts, items, now, tz });
  const c = continueLesson(a.session, a.hearts, now);
  return { session: c.session, hearts: c.hearts, items: a.items };
}

test('start refused at 0 hearts', () => {
  expect(startLesson(lesson, { count: 0, lastRegenAt: T }, T + M).ok).toBe(false);
});

test('startLesson regenerates before refusing', () => {
  const r = startLesson(lesson, { count: 0, lastRegenAt: T }, T + 31 * M);
  expect(r.ok).toBe(true);
  expect(r.hearts.count).toBe(1);
});

test('refusal returns regenerated hearts and reason', () => {
  const r = startLesson(lesson, { count: 0, lastRegenAt: T }, T + 29 * M);
  expect(r).toEqual({ ok: false, reason: 'no_hearts', hearts: { count: 0, lastRegenAt: T } });
});

test('start: theory status, queue in content order, nothing shown yet', () => {
  expect(start.ok).toBe(true);
  expect(start.session).toEqual({
    lessonId: 't1.s01.l01',
    queue: lesson.tasks.map((t) => t.id),
    solved: [],
    mistakes: 0,
    status: 'theory',
    presentation: 0,
  });
  expect(currentTaskId(start.session)).toBeNull();
});

test('beginTasks: theory → in_progress, shows queue[0]; no-op otherwise', () => {
  const s = beginTasks(start.session);
  expect(s.status).toBe('in_progress');
  expect(currentTaskId(s)).toBe('t1.s01.l01.t01');
  expect(s.presentation).toBe(1);
  expect(start.session.status).toBe('theory');
  expect(beginTasks(s)).toBe(s);
});

test('correct answer dequeues, adds to solved, never touches items', () => {
  const s = beginTasks(start.session);
  const items: ReviewItems = {
    't1.s01.l01.t01': { taskId: 't1.s01.l01.t01', box: 2, dueDate: '2026-10-20' },
  };
  const hearts = { count: 3, lastRegenAt: T };
  const r = answerLessonTask(s, true, { hearts, items, now: T, tz });
  expect(r.session.queue[0]).toBe('t1.s01.l01.t02');
  expect(r.session.queue).toHaveLength(9);
  expect(r.session.solved).toEqual(['t1.s01.l01.t01']);
  expect(r.session.mistakes).toBe(0);
  expect(r.items).toBe(items);
  expect(r.hearts).toBe(hearts);
  expect(s.solved).toEqual([]);
});

test('wrong answer requeues to the end, costs a heart, marks Leitner', () => {
  const s = beginTasks(start.session);
  const r = answerLessonTask(s, false, {
    hearts: { count: 5, lastRegenAt: T },
    items: {},
    now: T,
    tz,
  });
  expect(r.session.queue[r.session.queue.length - 1]).toBe('t1.s01.l01.t01');
  expect(r.session.queue[0]).toBe('t1.s01.l01.t02');
  expect(r.session.mistakes).toBe(1);
  expect(r.hearts).toEqual({ count: 4, lastRegenAt: T });
  expect(r.items['t1.s01.l01.t01']).toEqual({
    taskId: 't1.s01.l01.t01',
    box: 1,
    dueDate: '2026-10-19',
  });
});

test('wrong answer uses the user time zone for the Leitner due date', () => {
  // 2026-10-18 22:30 UTC is already 2026-10-19 in Moscow.
  const now = Date.UTC(2026, 9, 18, 22, 30);
  const s = beginTasks(start.session);
  const hearts = { count: 5, lastRegenAt: now };
  const msk = answerLessonTask(s, false, { hearts, items: {}, now, tz });
  const utc = answerLessonTask(s, false, { hearts, items: {}, now, tz: 'UTC' });
  expect(msk.items['t1.s01.l01.t01']?.dueDate).toBe('2026-10-20');
  expect(utc.items['t1.s01.l01.t01']?.dueDate).toBe('2026-10-19');
});

test('answering outside in_progress is a no-op', () => {
  const ctx = { hearts: { count: 5, lastRegenAt: T }, items: {}, now: T, tz };
  const r = answerLessonTask(start.session, false, ctx);
  expect(r.session).toBe(start.session);
  expect(r.hearts).toBe(ctx.hearts);
  expect(r.items).toBe(ctx.items);
});

test('continueLesson increments presentation; no-op outside in_progress', () => {
  const r = step(beginTasks(start.session), true, { count: 5, lastRegenAt: T }, {}, T);
  expect(r.session.status).toBe('in_progress');
  expect(r.session.presentation).toBe(2);
  expect(currentTaskId(r.session)).toBe('t1.s01.l01.t02');
  const c = continueLesson(start.session, { count: 5, lastRegenAt: T }, T);
  expect(c.session).toBe(start.session);
});

test('completes only when queue empty; mistakes counts every wrong', () => {
  let s = beginTasks(start.session);
  let hearts: Hearts = { count: 5, lastRegenAt: T };
  let items: ReviewItems = {};
  ({ session: s, hearts, items } = step(s, false, hearts, items, T));
  for (let i = 2; i <= 10; i++) {
    ({ session: s, hearts, items } = step(s, true, hearts, items, T));
    expect(s.status).toBe('in_progress');
  }
  expect(s.queue).toEqual(['t1.s01.l01.t01']);
  ({ session: s, hearts, items } = step(s, false, hearts, items, T));
  expect(s.status).toBe('in_progress');
  expect(currentTaskId(s)).toBe('t1.s01.l01.t01');
  ({ session: s, hearts, items } = step(s, true, hearts, items, T));
  expect(s.status).toBe('completed');
  expect(s.mistakes).toBe(2);
  expect(s.solved).toHaveLength(10);
  expect(new Set(s.solved).size).toBe(10);
  expect(s.queue).toEqual([]);
  expect(currentTaskId(s)).toBeNull();
  expect(hearts.count).toBe(3);
  expect(Object.keys(items)).toEqual(['t1.s01.l01.t01']);
});

test('0 hearts after mistake → out_of_hearts (terminal)', () => {
  const s = beginTasks(start.session);
  const r = step(s, false, { count: 1, lastRegenAt: T }, {}, T);
  expect(r.session.status).toBe('out_of_hearts');
  expect(r.hearts.count).toBe(0);
  expect(currentTaskId(r.session)).toBeNull();
  expect(r.items['t1.s01.l01.t01']?.box).toBe(1);
  const again = answerLessonTask(r.session, true, { hearts: r.hearts, items: r.items, now: T, tz });
  expect(again.session).toBe(r.session);
});

test('heart regenerated during lesson keeps it going', () => {
  const s = beginTasks(start.session);
  const a = answerLessonTask(s, false, {
    hearts: { count: 1, lastRegenAt: T },
    items: {},
    now: T,
    tz,
  });
  expect(a.hearts).toEqual({ count: 0, lastRegenAt: T });
  const c = continueLesson(a.session, a.hearts, T + 30 * M);
  expect(c.session.status).toBe('in_progress');
  expect(c.hearts.count).toBe(1);
  expect(currentTaskId(c.session)).toBe('t1.s01.l01.t02');
});

test('completeLesson: perfect lesson delta and summary', () => {
  const d = completeLesson({
    lessonId: 't1.s01.l01',
    mistakes: 0,
    streak: noStreak,
    xpToday: 0,
    now: T,
    tz,
  });
  expect(d).toEqual({
    xp: 15,
    completedLessonId: 't1.s01.l01',
    streak: { current: 1, best: 1, lastActivityDate: '2026-10-18' },
    summary: {
      kind: 'lesson',
      lessonId: 't1.s01.l01',
      mistakes: 0,
      perfect: true,
      xpGained: 15,
      xpToday: 15,
      dailyGoal: 30,
      goalJustReached: false,
      streak: 1,
      streakIncreased: true,
    },
  });
});

test('completeLesson: mistakes give 10 XP; same-day streak not increased', () => {
  const streak: Streak = { current: 1, best: 1, lastActivityDate: '2026-10-18' };
  const d = completeLesson({
    lessonId: 't1.s01.l01',
    mistakes: 1,
    streak,
    xpToday: 15,
    now: T + M,
    tz,
  });
  expect(d.xp).toBe(10);
  expect(d.streak).toEqual(streak);
  expect(d.summary).toMatchObject({
    xpGained: 10,
    xpToday: 25,
    perfect: false,
    mistakes: 1,
    streak: 1,
    streakIncreased: false,
  });
});

test('completeLesson: goal reached from xpToday 20', () => {
  const d = completeLesson({
    lessonId: 't1.s01.l02',
    mistakes: 0,
    streak: noStreak,
    xpToday: 20,
    now: T,
    tz,
  });
  expect(d.xp).toBe(15);
  expect(d.summary.goalJustReached).toBe(true);
  expect(d.summary.dailyGoal).toBe(30);
  expect(d.summary.xpToday).toBe(35);
});

test('completeLesson on the next day extends the streak', () => {
  const streak: Streak = { current: 4, best: 4, lastActivityDate: '2026-10-17' };
  const d = completeLesson({ lessonId: 't1.s01.l01', mistakes: 0, streak, xpToday: 0, now: T, tz });
  expect(d.streak).toEqual({ current: 5, best: 5, lastActivityDate: '2026-10-18' });
  expect(d.summary).toMatchObject({ streak: 5, streakIncreased: true });
});

test('completeLesson credits the calendar day of now in the user zone', () => {
  // 2026-10-19 00:03 in Moscow, still 2026-10-18 in UTC.
  const now = Date.UTC(2026, 9, 18, 21, 3);
  const streak: Streak = { current: 1, best: 1, lastActivityDate: '2026-10-18' };
  const d = completeLesson({ lessonId: 't1.s01.l01', mistakes: 0, streak, xpToday: 0, now, tz });
  expect(d.streak).toEqual({ current: 2, best: 2, lastActivityDate: '2026-10-19' });
  const utc = completeLesson({
    lessonId: 't1.s01.l01',
    mistakes: 0,
    streak,
    xpToday: 0,
    now,
    tz: 'UTC',
  });
  expect(utc.streak).toEqual(streak);
});

test('completeLesson after a broken but unrefreshed streak does not report an increase', () => {
  const streak: Streak = { current: 4, best: 4, lastActivityDate: '2026-10-15' };
  const d = completeLesson({ lessonId: 't1.s01.l01', mistakes: 0, streak, xpToday: 0, now: T, tz });
  expect(d.streak).toEqual({ current: 1, best: 4, lastActivityDate: '2026-10-18' });
  expect(d.summary).toMatchObject({ streak: 1, streakIncreased: false });
});
