// Lesson sessions (spec §5.1 «Сессии обучения», §9); review/drill sessions start in review.ts and
// share the answer path here. The rules live in `@rootcamp/logic`; this module loads and stores
// their state. Starts and answers lock the user's `hearts` row first (`SELECT … FOR UPDATE`),
// then the session row, then `streaks`, then `users`, so starts, answers and retries of one user
// run one at a time and never deadlock against each other. `abandonSession` is the exception: a
// single conditional UPDATE of one session row, it takes no other lock and cannot deadlock.
import type { AnswerBody, AnswerResponse, StartLessonResponse } from '@rootcamp/api-contract';
import type { UserAnswer as SchemaUserAnswer } from '@rootcamp/content-schema';
import {
  hearts as heartsTable,
  learningSessions,
  lessonCompletions,
  reviewItems,
  streaks,
  users,
  type Db,
} from '@rootcamp/db';
import {
  answerLessonTask,
  beginTasks,
  checkAnswer,
  completeLesson,
  continueLesson,
  currentTaskId,
  lessonStatuses,
  msToNextHeart,
  startLesson,
  toDateKey,
  type Hearts,
  type LessonSession,
  type ReviewItems,
  type ReviewSession,
} from '@rootcamp/logic';
import { and, eq, sql } from 'drizzle-orm';
import { HttpError } from '../plugins/errors.js';
import type { ContentStore } from './contentStore.js';
import type { Executor } from './executor.js';
import { completedLessonIds } from './progress.js';
import { answerReview } from './review.js';
import { applyXp, xpOnDay } from './rewards.js';

/** `learning_sessions.state`: the logic session plus the last answer, for idempotent retries. */
export interface StoredState<S = LessonSession> {
  session: S;
  lastAnswer?: { taskId: string; presentation: number; response: AnswerResponse };
}

export interface SessionUserRef {
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionNotFound(): HttpError {
  return new HttpError(404, 'not_found', 'session not found');
}

export function heartsDto(h: Hearts, now: number) {
  return { count: h.count, msToNext: msToNextHeart(h, now) };
}

/** Locks the user's `hearts` row; every learning mutation takes this lock first. */
export async function lockHearts(tx: Executor, userId: string): Promise<Hearts> {
  const [row] = await tx
    .select()
    .from(heartsTable)
    .where(eq(heartsTable.userId, userId))
    .for('update');
  if (!row) throw new Error(`user ${userId} has no hearts row`);
  return { count: row.count, lastRegenAt: row.lastRegenAt.getTime() };
}

export async function saveHearts(tx: Executor, userId: string, before: Hearts, after: Hearts) {
  if (after.count === before.count && after.lastRegenAt === before.lastRegenAt) return;
  await tx
    .update(heartsTable)
    .set({ count: after.count, lastRegenAt: new Date(after.lastRegenAt) })
    .where(eq(heartsTable.userId, userId));
}

export async function loadUser(tx: Executor, userId: string) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) throw new HttpError(401, 'unauthorized', 'sign in required');
  return user;
}

/**
 * `POST /api/lessons/:lessonId/start`. The lesson must be `current` or `completed` in its track
 * (`403 locked` otherwise, `404` for unknown ids and practice nodes) and a heart must be left
 * after regen (`403 no_hearts`). Any `in_progress` session of the user is closed as `abandoned`
 * and replaced. The session starts at the tasks (`beginTasks`): the client shows the theory.
 */
export async function startLessonSession(
  db: Db,
  store: ContentStore,
  user: SessionUserRef,
  lessonId: string,
  now: number,
): Promise<StartLessonResponse> {
  const lesson = store.lesson(lessonId);
  const track = store.trackOfLesson(lessonId);
  if (!lesson || lesson.kind !== 'lesson' || !track) {
    throw new HttpError(404, 'not_found', 'lesson not found');
  }
  return db.transaction(async (tx) => {
    const before = await lockHearts(tx, user.id);
    const statuses = lessonStatuses(track, await completedLessonIds(tx, store, user.id));
    const status = statuses[lessonId];
    if (status === undefined) throw new HttpError(404, 'not_found', 'lesson not found');
    if (status === 'locked') throw new HttpError(403, 'locked', 'lesson is locked');

    const started = startLesson(lesson, before, now);
    if (!started.ok) throw new HttpError(403, 'no_hearts', 'no hearts left');
    await saveHearts(tx, user.id, before, started.hearts);

    const session = beginTasks(started.session);
    await tx
      .update(learningSessions)
      .set({ status: 'abandoned', updatedAt: new Date(now) })
      .where(and(eq(learningSessions.userId, user.id), eq(learningSessions.status, 'in_progress')));
    const state: StoredState = { session };
    const [row] = await tx
      .insert(learningSessions)
      .values({
        userId: user.id,
        kind: 'lesson',
        lessonId,
        contentVersion: store.version,
        state,
        startedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .returning({ id: learningSessions.id });
    return {
      sessionId: row!.id,
      hearts: heartsDto(started.hearts, now),
      queue: session.queue,
      presentation: session.presentation,
    };
  });
}

type Outcome = { response: AnswerResponse } | { error: HttpError };

/**
 * `POST /api/sessions/:id/answer` for lessons, reviews and drills, in one transaction:
 * - the same `taskId` + `presentation` as the last answer returns that answer's response and
 *   changes nothing (§9 retries; also after the session ended);
 * - a session that is no longer `in_progress` → `409 session_closed` (`content_changed` if that
 *   is how it ended);
 * - a session of another content version is closed as `content_changed` (no reward, no
 *   penalty) → `409 content_changed`;
 * - another task or presentation than the one shown → `409 out_of_order`;
 * - otherwise, in a lesson, `checkAnswer` → `answerLessonTask` → `continueLesson`; a wrong answer
 *   stores the Leitner item, `completed` runs `completeLesson` and credits XP, `out_of_hearts`
 *   closes the session; review and drill answers go to `answerReview` (review.ts).
 */
export async function answerInSession(
  db: Db,
  store: ContentStore,
  user: SessionUserRef,
  sessionId: string,
  body: AnswerBody,
  now: number,
): Promise<AnswerResponse> {
  if (!UUID.test(sessionId)) throw sessionNotFound();
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const heartsBefore = await lockHearts(tx, user.id);
    const [row] = await tx
      .select()
      .from(learningSessions)
      .where(and(eq(learningSessions.id, sessionId), eq(learningSessions.userId, user.id)))
      .for('update');
    if (!row) throw sessionNotFound();
    const state = row.state as StoredState;

    const last = state.lastAnswer;
    if (last && last.taskId === body.taskId && last.presentation === body.presentation) {
      return { response: last.response };
    }
    if (row.status === 'content_changed') {
      throw new HttpError(409, 'content_changed', 'the course was updated, restart the lesson');
    }
    if (row.status !== 'in_progress') {
      throw new HttpError(409, 'session_closed', 'this session is closed');
    }
    if (row.contentVersion !== store.version) {
      // Committed before the error is sent: the session must stay closed.
      await tx
        .update(learningSessions)
        .set({ status: 'content_changed', updatedAt: new Date(now) })
        .where(eq(learningSessions.id, row.id));
      return {
        error: new HttpError(409, 'content_changed', 'the course was updated, restart the lesson'),
      };
    }
    const response =
      row.kind === 'lesson'
        ? await answerLesson(tx, store, user, row.id, state, body, heartsBefore, now)
        : await answerReview(tx, store, user, {
            rowId: row.id,
            state: state as unknown as StoredState<ReviewSession>,
            body,
            heartsBefore,
            now,
          });
    return { response };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.response;
}

async function answerLesson(
  tx: Executor,
  store: ContentStore,
  user: SessionUserRef,
  rowId: string,
  state: StoredState,
  body: AnswerBody,
  heartsBefore: Hearts,
  now: number,
): Promise<AnswerResponse> {
  const s = state.session;
  const taskId = currentTaskId(s);
  if (taskId === null || taskId !== body.taskId || s.presentation !== body.presentation) {
    throw new HttpError(409, 'out_of_order', 'this task is not the current one');
  }
  const task = store.task(taskId);
  if (!task) throw new Error(`task ${taskId} is missing from content ${store.version}`);
  const u = await loadUser(tx, user.id);

  // The contract schema mirrors content-schema's UserAnswer.
  const check = checkAnswer(task, body.answer satisfies SchemaUserAnswer);
  const answered = answerLessonTask(s, check.correct, {
    hearts: heartsBefore,
    items: {} satisfies ReviewItems,
    now,
    tz: u.tz,
  });
  const next = continueLesson(answered.session, answered.hearts, now);
  await saveHearts(tx, user.id, heartsBefore, next.hearts);

  const item = answered.items[taskId];
  if (!check.correct && item) {
    await tx
      .insert(reviewItems)
      .values({ userId: user.id, taskId, box: item.box, dueDate: item.dueDate })
      .onConflictDoUpdate({
        target: [reviewItems.userId, reviewItems.taskId],
        set: { box: item.box, dueDate: item.dueDate },
      });
  }

  const status = next.session.status;
  let summary: AnswerResponse['summary'];
  if (status === 'completed') {
    summary = await rewardLesson(tx, store, u, next.session, now);
  }
  const response: AnswerResponse = {
    correct: check.correct,
    correctAnswerText: check.correctAnswerText,
    hearts: heartsDto(next.hearts, now),
    status: status === 'theory' ? 'in_progress' : status,
    nextTaskId: currentTaskId(next.session),
    presentation: next.session.presentation,
    ...(summary ? { summary } : {}),
  };
  const newState: StoredState = {
    session: next.session,
    lastAnswer: { taskId, presentation: body.presentation, response },
  };
  await tx
    .update(learningSessions)
    .set({
      state: newState,
      status: status === 'completed' || status === 'out_of_hearts' ? status : 'in_progress',
      updatedAt: new Date(now),
    })
    .where(eq(learningSessions.id, rowId));
  return response;
}

/**
 * The completed lesson's reward on the calendar day of `now` in the user's zone: streak,
 * `lesson_completions` (times + 1, best mistakes kept), then XP and rank via `applyXp`.
 */
async function rewardLesson(
  tx: Executor,
  store: ContentStore,
  user: { id: string; tz: string },
  session: LessonSession,
  now: number,
) {
  const [s] = await tx.select().from(streaks).where(eq(streaks.userId, user.id)).for('update');
  if (!s) throw new Error(`user ${user.id} has no streaks row`);
  const delta = completeLesson({
    lessonId: session.lessonId,
    mistakes: session.mistakes,
    streak: { current: s.current, best: s.best, lastActivityDate: s.lastActivityDate },
    xpToday: await xpOnDay(tx, user.id, toDateKey(now, user.tz)),
    now,
    tz: user.tz,
  });
  await tx
    .update(streaks)
    .set({
      current: delta.streak.current,
      best: delta.streak.best,
      lastActivityDate: delta.streak.lastActivityDate,
    })
    .where(eq(streaks.userId, user.id));
  await tx
    .insert(lessonCompletions)
    .values({
      userId: user.id,
      lessonId: delta.completedLessonId,
      firstCompletedAt: new Date(now),
      bestMistakes: session.mistakes,
    })
    .onConflictDoUpdate({
      target: [lessonCompletions.userId, lessonCompletions.lessonId],
      set: {
        times: sql`${lessonCompletions.times} + 1`,
        bestMistakes: sql`least(${lessonCompletions.bestMistakes}, excluded.best_mistakes)`,
      },
    });
  await applyXp(tx, user, {
    amount: delta.xp,
    source: 'lesson',
    refId: delta.completedLessonId,
    now,
    store,
  });
  return delta.summary;
}

/**
 * `POST /api/sessions/:id/abandon`: closes the user's `in_progress` session without reward or
 * penalty. Closing an already closed session is a no-op; unknown ids → 404.
 */
export async function abandonSession(
  db: Db,
  user: SessionUserRef,
  sessionId: string,
  now: number,
): Promise<void> {
  if (!UUID.test(sessionId)) throw sessionNotFound();
  const [row] = await db
    .select({ id: learningSessions.id })
    .from(learningSessions)
    .where(and(eq(learningSessions.id, sessionId), eq(learningSessions.userId, user.id)));
  if (!row) throw sessionNotFound();
  await db
    .update(learningSessions)
    .set({ status: 'abandoned', updatedAt: new Date(now) })
    .where(and(eq(learningSessions.id, sessionId), eq(learningSessions.status, 'in_progress')));
}
