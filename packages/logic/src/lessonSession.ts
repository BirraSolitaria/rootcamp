import type { Lesson } from '@rootcamp/content-schema';
import { toDateKey } from './dates.js';
import { loseHeart, regen } from './hearts.js';
import { markWrong } from './leitner.js';
import { grantReward } from './reward.js';
import type { Hearts, LessonSummary, ReviewItems, Streak, TaskId } from './types.js';
import { DAILY_GOAL, lessonXp } from './xp.js';

/**
 * Lesson in progress; JSON-serializable (stored as jsonb). `solved` keeps
 * solved task ids in solve order; `presentation` increments on every (re)show
 * of a task, the UI uses it as a view key.
 */
export interface LessonSession {
  lessonId: string;
  queue: TaskId[];
  solved: TaskId[];
  mistakes: number;
  status: 'theory' | 'in_progress' | 'out_of_hearts' | 'completed';
  presentation: number;
}

export type StartLessonResult =
  | { ok: true; session: LessonSession; hearts: Hearts }
  | { ok: false; reason: 'no_hearts'; hearts: Hearts };

/** Regenerates hearts first and refuses when none remain. */
export function startLesson(lesson: Lesson, hearts: Hearts, now: number): StartLessonResult {
  const h = regen(hearts, now);
  if (h.count === 0) return { ok: false, reason: 'no_hearts', hearts: h };
  return {
    ok: true,
    hearts: h,
    session: {
      lessonId: lesson.id,
      queue: lesson.tasks.map((t) => t.id),
      solved: [],
      mistakes: 0,
      status: 'theory',
      presentation: 0,
    },
  };
}

/** «Начать задания»: shows queue[0]. */
export function beginTasks(s: LessonSession): LessonSession {
  if (s.status !== 'theory') return s;
  return { ...s, status: 'in_progress', presentation: s.presentation + 1 };
}

export function currentTaskId(s: LessonSession): TaskId | null {
  return s.status === 'in_progress' ? (s.queue[0] ?? null) : null;
}

/**
 * Correct: dequeue into `solved` (review items untouched).
 * Wrong: mistakes+1, loseHeart, markWrong on the user's calendar day, requeue at the end.
 */
export function answerLessonTask(
  s: LessonSession,
  correct: boolean,
  ctx: { hearts: Hearts; items: ReviewItems; now: number; tz: string },
): { session: LessonSession; hearts: Hearts; items: ReviewItems } {
  const taskId = currentTaskId(s);
  if (taskId === null) return { session: s, hearts: ctx.hearts, items: ctx.items };
  const rest = s.queue.slice(1);
  if (correct) {
    return {
      session: { ...s, queue: rest, solved: [...s.solved, taskId] },
      hearts: ctx.hearts,
      items: ctx.items,
    };
  }
  return {
    session: { ...s, queue: [...rest, taskId], mistakes: s.mistakes + 1 },
    hearts: loseHeart(ctx.hearts, ctx.now),
    items: markWrong(ctx.items, taskId, toDateKey(ctx.now, ctx.tz)),
  };
}

/**
 * After «Продолжить»: regen; empty queue → completed; 0 hearts → out_of_hearts
 * (terminal, the caller discards the session); otherwise the next task is shown.
 */
export function continueLesson(
  s: LessonSession,
  hearts: Hearts,
  now: number,
): { session: LessonSession; hearts: Hearts } {
  const h = regen(hearts, now);
  if (s.status !== 'in_progress') return { session: s, hearts: h };
  if (s.queue.length === 0) return { session: { ...s, status: 'completed' }, hearts: h };
  if (h.count === 0) return { session: { ...s, status: 'out_of_hearts' }, hearts: h };
  return { session: { ...s, presentation: s.presentation + 1 }, hearts: h };
}

/** What completing a lesson changes; `api` applies it in one transaction. */
export interface LessonDelta {
  xp: number;
  completedLessonId: string;
  streak: Streak;
  summary: LessonSummary;
}

/**
 * Credits XP and streak to the calendar day of `now` in `tz`.
 * `xpToday` is the XP already earned that day, before this lesson.
 */
export function completeLesson(i: {
  lessonId: string;
  mistakes: number;
  streak: Streak;
  xpToday: number;
  now: number;
  tz: string;
}): LessonDelta {
  const r = grantReward({
    streak: i.streak,
    xpToday: i.xpToday,
    xp: lessonXp(i.mistakes),
    today: toDateKey(i.now, i.tz),
  });
  return {
    xp: r.xp,
    completedLessonId: i.lessonId,
    streak: r.streak,
    summary: {
      kind: 'lesson',
      lessonId: i.lessonId,
      mistakes: i.mistakes,
      perfect: i.mistakes === 0,
      xpGained: r.xp,
      xpToday: r.xpToday,
      dailyGoal: DAILY_GOAL,
      goalJustReached: r.goalJustReached,
      streak: r.streak.current,
      streakIncreased: r.streakIncreased,
    },
  };
}
