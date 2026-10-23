// Review (Leitner) and drill («тренировка») sessions (spec §5.1, §7.6). The rules live in
// `@rootcamp/logic` (reviewSession.ts, leitner.ts); this module loads and stores their state.
// Answers arrive through `answerInSession` (lessons.ts), which takes the locks: hearts → session;
// completion then locks `streaks`, and `applyXp` updates `users`.
import type { AnswerBody, AnswerResponse, StartReviewResponse } from '@rootcamp/api-contract';
import type { UserAnswer as SchemaUserAnswer } from '@rootcamp/content-schema';
import { learningSessions, reviewItems, streaks, type Db } from '@rootcamp/db';
import {
  advanceReview,
  answerReviewTask,
  buildReviewSession,
  checkAnswer,
  completeReview,
  currentReviewTaskId,
  regen,
  toDateKey,
  type Hearts,
  type LeitnerItem,
  type ReviewItems,
  type ReviewMode,
  type ReviewSession,
} from '@rootcamp/logic';
import { and, eq } from 'drizzle-orm';
import { HttpError } from '../plugins/errors.js';
import type { ContentStore } from './contentStore.js';
import type { Executor } from './executor.js';
import {
  heartsDto,
  loadUser,
  lockHearts,
  saveHearts,
  type SessionUserRef,
  type StoredState,
} from './lessons.js';
import { completedLessonIds } from './progress.js';
import { applyXp, xpOnDay } from './rewards.js';

/** The user's Leitner items, optionally only the one of `taskId`. */
async function loadItems(tx: Executor, userId: string, taskId?: string): Promise<ReviewItems> {
  const rows = await tx
    .select()
    .from(reviewItems)
    .where(
      taskId === undefined
        ? eq(reviewItems.userId, userId)
        : and(eq(reviewItems.userId, userId), eq(reviewItems.taskId, taskId)),
    );
  const items: ReviewItems = {};
  for (const r of rows) {
    items[r.taskId] = { taskId: r.taskId, box: r.box as LeitnerItem['box'], dueDate: r.dueDate };
  }
  return items;
}

/** Writes the change of one task's Leitner item: upsert, delete, or nothing. */
async function saveItem(
  tx: Executor,
  userId: string,
  taskId: string,
  before: LeitnerItem | undefined,
  after: LeitnerItem | undefined,
) {
  if (after === undefined) {
    if (before !== undefined) {
      await tx
        .delete(reviewItems)
        .where(and(eq(reviewItems.userId, userId), eq(reviewItems.taskId, taskId)));
    }
    return;
  }
  if (before && before.box === after.box && before.dueDate === after.dueDate) return;
  await tx
    .insert(reviewItems)
    .values({ userId, taskId, box: after.box, dueDate: after.dueDate })
    .onConflictDoUpdate({
      target: [reviewItems.userId, reviewItems.taskId],
      set: { box: after.box, dueDate: after.dueDate },
    });
}

/**
 * `POST /api/review/start`. `review` asks up to 10 due items, `drill` up to 10 random tasks of
 * completed lessons and only while nothing is due (`buildReviewSession`); `terminal_practice`
 * never appears in either. `null` (→ 204) when there is nothing to ask — then the user's
 * unfinished session is left alone; otherwise it is closed as `abandoned` and replaced. No heart
 * is needed: a review is how hearts come back.
 */
export async function startReview(
  db: Db,
  store: ContentStore,
  user: SessionUserRef,
  mode: ReviewMode,
  now: number,
): Promise<StartReviewResponse | null> {
  return db.transaction(async (tx) => {
    const hearts = await lockHearts(tx, user.id);
    const u = await loadUser(tx, user.id);
    const built = buildReviewSession(mode, {
      items: await loadItems(tx, user.id),
      completedLessonIds: await completedLessonIds(tx, store, user.id),
      index: store.index,
      today: toDateKey(now, u.tz),
      rng: Math.random,
    });
    if (!built) return null;
    // The first show is presentation 1, as in lessons (`AnswerBody.presentation` is positive).
    const session: ReviewSession = { ...built, presentation: built.presentation + 1 };

    await tx
      .update(learningSessions)
      .set({ status: 'abandoned', updatedAt: new Date(now) })
      .where(and(eq(learningSessions.userId, user.id), eq(learningSessions.status, 'in_progress')));
    const state: StoredState<ReviewSession> = { session };
    const [row] = await tx
      .insert(learningSessions)
      .values({
        userId: user.id,
        kind: mode,
        lessonId: null,
        contentVersion: store.version,
        state,
        startedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .returning({ id: learningSessions.id });
    return {
      sessionId: row!.id,
      taskIds: session.taskIds,
      hearts: heartsDto(regen(hearts, now), now),
      presentation: session.presentation,
      contentVersion: store.version,
    };
  });
}

/**
 * The review/drill branch of `answerInSession`, inside its transaction (hearts and the session
 * row already locked, version checked): `checkAnswer` → `answerReviewTask` → `advanceReview`.
 * The Leitner item of the task changes at once (a wrong answer → box 1; a right one in review →
 * next box or removed after box 3; a right one in drill → unchanged). Wrong answers cost no
 * hearts. On `completed`: `completeReview` (XP = right answers, +1 heart, streak), XP credited
 * with `source` = the mode.
 */
export async function answerReview(
  tx: Executor,
  store: ContentStore,
  user: SessionUserRef,
  a: {
    rowId: string;
    state: StoredState<ReviewSession>;
    body: AnswerBody;
    heartsBefore: Hearts;
    now: number;
  },
): Promise<AnswerResponse> {
  const { body, heartsBefore, now } = a;
  const s = a.state.session;
  const taskId = currentReviewTaskId(s);
  if (taskId === null || taskId !== body.taskId || s.presentation !== body.presentation) {
    throw new HttpError(409, 'out_of_order', 'this task is not the current one');
  }
  const task = store.task(taskId);
  if (!task) throw new Error(`task ${taskId} is missing from content ${store.version}`);
  const u = await loadUser(tx, user.id);
  const today = toDateKey(now, u.tz);

  // The contract schema mirrors content-schema's UserAnswer.
  const check = checkAnswer(task, body.answer satisfies SchemaUserAnswer);
  const items = await loadItems(tx, user.id, taskId);
  const answered = answerReviewTask(s, check.correct, items, today);
  await saveItem(tx, user.id, taskId, items[taskId], answered.items[taskId]);
  const next = advanceReview(answered.session);

  let hearts = regen(heartsBefore, now);
  let summary: AnswerResponse['summary'];
  if (next.status === 'completed') {
    const [st] = await tx.select().from(streaks).where(eq(streaks.userId, user.id)).for('update');
    if (!st) throw new Error(`user ${user.id} has no streaks row`);
    const delta = completeReview({
      session: next,
      hearts: heartsBefore,
      streak: { current: st.current, best: st.best, lastActivityDate: st.lastActivityDate },
      xpToday: await xpOnDay(tx, user.id, today),
      now,
      tz: u.tz,
    });
    await tx
      .update(streaks)
      .set({
        current: delta.streak.current,
        best: delta.streak.best,
        lastActivityDate: delta.streak.lastActivityDate,
      })
      .where(eq(streaks.userId, user.id));
    await saveHearts(tx, user.id, heartsBefore, delta.hearts);
    hearts = delta.hearts;
    if (delta.xp > 0) {
      await applyXp(tx, u, { amount: delta.xp, source: s.mode, refId: null, now, store });
    }
    summary = delta.summary;
  }

  const response: AnswerResponse = {
    correct: check.correct,
    correctAnswerText: check.correctAnswerText,
    hearts: heartsDto(hearts, now),
    status: next.status,
    nextTaskId: currentReviewTaskId(next),
    presentation: next.presentation,
    ...(summary ? { summary } : {}),
  };
  const newState: StoredState<ReviewSession> = {
    session: next,
    lastAnswer: { taskId, presentation: body.presentation, response },
  };
  await tx
    .update(learningSessions)
    .set({ state: newState, status: next.status, updatedAt: new Date(now) })
    .where(eq(learningSessions.id, a.rowId));
  return response;
}
