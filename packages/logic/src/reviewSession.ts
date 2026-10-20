import type { CourseIndex } from './courseQuery.js';
import { findTask, tasksOfLessons } from './courseQuery.js';
import { toDateKey } from './dates.js';
import { gainHeart, regen } from './hearts.js';
import { dueItems, markCorrectInReview, markWrong } from './leitner.js';
import { grantReward } from './reward.js';
import { shuffle } from './shuffle.js';
import type { DateKey, Hearts, ReviewItems, ReviewSummary, Streak, TaskId } from './types.js';
import { DAILY_GOAL } from './xp.js';

/** `review` — due Leitner items; `drill` («тренировка») — random tasks of completed lessons. */
export type ReviewMode = 'review' | 'drill';
export const REVIEW_LIMIT = 10;

/** Each task is asked once; `presentation` increments on every show (UI view key). */
export interface ReviewSession {
  mode: ReviewMode;
  taskIds: TaskId[];
  index: number;
  correct: number;
  status: 'in_progress' | 'completed';
  presentation: number;
}

/**
 * Due task ids (dueItems order) that exist in the loaded course and are not
 * terminal_practice; shared by the session and the «К повторению» counter.
 */
export function dueTaskIdsInCourse(items: ReviewItems, ix: CourseIndex, today: DateKey): TaskId[] {
  return dueItems(items, today)
    .filter((i) => {
      const task = findTask(ix, i.taskId);
      return task !== undefined && task.type !== 'terminal_practice';
    })
    .map((i) => i.taskId);
}

/**
 * review: first min(10, due) due items. drill: only when nothing is due;
 * up to 10 shuffled tasks of completed lessons (terminal_practice excluded).
 * Returns null when there is nothing to ask.
 */
export function buildReviewSession(
  mode: ReviewMode,
  input: {
    items: ReviewItems;
    completedLessonIds: string[];
    index: CourseIndex;
    today: DateKey;
    rng: () => number;
  },
): ReviewSession | null {
  const due = dueTaskIdsInCourse(input.items, input.index, input.today);
  let taskIds: TaskId[];
  if (mode === 'review') {
    taskIds = due.slice(0, REVIEW_LIMIT);
  } else {
    if (due.length > 0) return null;
    const pool = tasksOfLessons(input.index, input.completedLessonIds).map((t) => t.id);
    taskIds = shuffle(pool, input.rng).slice(0, REVIEW_LIMIT);
  }
  if (taskIds.length === 0) return null;
  return { mode, taskIds, index: 0, correct: 0, status: 'in_progress', presentation: 0 };
}

export function currentReviewTaskId(s: ReviewSession): TaskId | null {
  return s.status === 'in_progress' ? (s.taskIds[s.index] ?? null) : null;
}

/** Boxes change immediately; a correct drill answer leaves boxes alone. */
export function answerReviewTask(
  s: ReviewSession,
  correct: boolean,
  items: ReviewItems,
  today: DateKey,
): { session: ReviewSession; items: ReviewItems } {
  const taskId = currentReviewTaskId(s);
  if (taskId === null) return { session: s, items };
  if (!correct) return { session: s, items: markWrong(items, taskId, today) };
  return {
    session: { ...s, correct: s.correct + 1 },
    items: s.mode === 'review' ? markCorrectInReview(items, taskId, today) : items,
  };
}

export function advanceReview(s: ReviewSession): ReviewSession {
  if (s.status !== 'in_progress') return s;
  const index = s.index + 1;
  return {
    ...s,
    index,
    presentation: s.presentation + 1,
    status: index >= s.taskIds.length ? 'completed' : 'in_progress',
  };
}

/** What completing a review/drill changes; `api` applies it in one transaction. */
export interface ReviewDelta {
  xp: number;
  hearts: Hearts;
  streak: Streak;
  summary: ReviewSummary;
}

/**
 * XP = correct answers, +1 heart (max 5), streak; credited to the calendar
 * day of `now` in `tz`. An unfinished session grants nothing: `xp: 0`,
 * hearts and streak returned unchanged.
 */
export function completeReview(i: {
  session: ReviewSession;
  hearts: Hearts;
  streak: Streak;
  xpToday: number;
  now: number;
  tz: string;
}): ReviewDelta {
  const s = i.session;
  const base = {
    kind: 'review' as const,
    mode: s.mode,
    correct: s.correct,
    total: s.taskIds.length,
    dailyGoal: DAILY_GOAL,
  };
  if (s.status !== 'completed') {
    return {
      xp: 0,
      hearts: i.hearts,
      streak: i.streak,
      summary: {
        ...base,
        heartGained: false,
        xpGained: 0,
        xpToday: i.xpToday,
        goalJustReached: false,
        streak: i.streak.current,
        streakIncreased: false,
      },
    };
  }
  const r = grantReward({
    streak: i.streak,
    xpToday: i.xpToday,
    xp: s.correct,
    today: toDateKey(i.now, i.tz),
  });
  const hearts = gainHeart(i.hearts, i.now);
  return {
    xp: r.xp,
    hearts,
    streak: r.streak,
    summary: {
      ...base,
      heartGained: hearts.count > regen(i.hearts, i.now).count,
      xpGained: r.xp,
      xpToday: r.xpToday,
      goalJustReached: r.goalJustReached,
      streak: r.streak.current,
      streakIncreased: r.streakIncreased,
    },
  };
}
