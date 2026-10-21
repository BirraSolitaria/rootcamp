// Review (Leitner) and drill sessions (plan M3 Task 6, spec §5.1, §7.6): start, answer, complete.
// Runs on the M1 `mini` fixture course (track t9: l01–l04 + practice node inc-demo, whose built
// lesson `t9.s01.p-inc-demo` holds one terminal_practice task).
import { rm } from 'node:fs/promises';
import {
  AnswerResponse,
  StartLessonResponse,
  StartReviewResponse,
  type UserAnswer,
} from '@rootcamp/api-contract';
import type { Task } from '@rootcamp/content-schema';
import {
  hearts,
  learningSessions,
  lessonCompletions,
  reviewItems,
  streaks,
  users,
  xpEvents,
} from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { HttpError } from '../src/plugins/errors.js';
import {
  loadContentStore,
  type ContentHolder,
  type ContentStore,
} from '../src/services/contentStore.js';
import { rightAnswer, wrongAnswer } from './answers.js';
import { buildCourse, MINI_CONTENT, tempContentDir } from './course.js';
import { harnessAppDeps, TEST_PUBLIC_ORIGIN, useHarness } from './harness.js';

const contentDir = tempContentDir();
let active: ContentStore | null = null;
const holder: ContentHolder = {
  current() {
    if (!active) throw new HttpError(503, 'internal', 'course content is not available');
    return active;
  },
  peek: () => active,
  reload: async () => {},
  close: async () => {},
};
const h = useHarness({
  appFactory: (d) => buildApp({ ...harnessAppDeps(d), content: holder }),
});
const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };

let v1: ContentStore;
let v2: ContentStore;
beforeAll(async () => {
  v1 = await loadContentStore(contentDir, await buildCourse(contentDir, MINI_CONTENT));
  const hash2 = await buildCourse(contentDir, MINI_CONTENT, (tree) => {
    tree.tracks[0]!.src.title += ' (v2)';
  });
  v2 = await loadContentStore(contentDir, hash2);
}, 60_000);
beforeEach(() => {
  active = v1;
});
afterAll(async () => {
  await rm(contentDir, { recursive: true, force: true });
});

const L1 = 't9.s01.l01';
const PRACTICE = 't9.s01.p-inc-demo';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type Cookies = Record<string, string>;

async function signIn(nick = 'ann'): Promise<{ id: string; cookies: Cookies }> {
  const res = await h().app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: csrf,
    payload: { email: `${nick}@mail.ru`, nick, password: 'correct horse battery', tz: 'UTC' },
  });
  expect(res.statusCode).toBe(201);
  const { user } = res.json() as { user: { id: string } };
  await h().db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  return { id: user.id, cookies: { rc_sid: res.cookies.find((c) => c.name === 'rc_sid')!.value } };
}

function task(id: string): Task {
  const t = active!.task(id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

function reviewStart(cookies: Cookies, mode: unknown) {
  return h().app.inject({
    method: 'POST',
    url: '/api/review/start',
    headers: csrf,
    cookies,
    payload: { mode },
  });
}

async function reviewStartOk(cookies: Cookies, mode: 'review' | 'drill') {
  const res = await reviewStart(cookies, mode);
  expect(res.statusCode, res.body).toBe(200);
  return StartReviewResponse.parse(res.json());
}

function answer(
  cookies: Cookies,
  sessionId: string,
  body: { taskId: string; presentation: number; answer: UserAnswer },
) {
  return h().app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/answer`,
    headers: csrf,
    cookies,
    payload: body,
  });
}

/** Answers every task the session shows, wrong where `wrong(taskId)`. */
async function play(
  cookies: Cookies,
  sessionId: string,
  first: string,
  presentation: number,
  wrong: (taskId: string) => boolean = () => false,
): Promise<{ responses: AnswerResponse[]; shown: string[] }> {
  let taskId: string | null = first;
  let p = presentation;
  const responses: AnswerResponse[] = [];
  const shown: string[] = [];
  while (taskId !== null) {
    shown.push(taskId);
    const res = await answer(cookies, sessionId, {
      taskId,
      presentation: p,
      answer: wrong(taskId) ? wrongAnswer(task(taskId)) : rightAnswer(task(taskId)),
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = AnswerResponse.parse(res.json());
    responses.push(r);
    taskId = r.nextTaskId;
    p = r.presentation;
  }
  return { responses, shown };
}

/** Plays L1 with one mistake on its first task; returns that task id. */
async function lessonWithOneMistake(cookies: Cookies): Promise<string> {
  const res = await h().app.inject({
    method: 'POST',
    url: `/api/lessons/${L1}/start`,
    headers: csrf,
    cookies,
  });
  expect(res.statusCode, res.body).toBe(200);
  const s = StartLessonResponse.parse(res.json());
  const first = s.queue[0]!;
  let missed = false;
  const { responses } = await play(cookies, s.sessionId, first, s.presentation, (taskId) => {
    if (taskId !== first || missed) return false;
    missed = true;
    return true;
  });
  expect(responses.at(-1)!.status).toBe('completed');
  return first;
}

async function itemsOf(userId: string) {
  return h().db.select().from(reviewItems).where(eq(reviewItems.userId, userId));
}

async function heartsOf(userId: string) {
  const [row] = await h().db.select().from(hearts).where(eq(hearts.userId, userId));
  return row!.count;
}

async function xpEventsOf(userId: string) {
  return h().db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
}

async function sessionRow(id: string) {
  const [row] = await h().db.select().from(learningSessions).where(eq(learningSessions.id, id));
  return row!;
}

/** Puts the user at `count` hearts, the regen timer starting now. */
async function setHearts(userId: string, count: number) {
  await h()
    .db.update(hearts)
    .set({ count, lastRegenAt: new Date(h().clock.now()) })
    .where(eq(hearts.userId, userId));
}

describe('POST /api/review/start', () => {
  it('400 validation for an unknown mode', async () => {
    const { cookies } = await signIn();
    const res = await reviewStart(cookies, 'practice');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
  });

  it('review: 204 when nothing is due (new user, or the mistake is due tomorrow)', async () => {
    const { cookies } = await signIn();
    expect((await reviewStart(cookies, 'review')).statusCode).toBe(204);
    await lessonWithOneMistake(cookies);
    expect((await reviewStart(cookies, 'review')).statusCode).toBe(204);
  });

  it('drill: 204 for a new user without completed lessons', async () => {
    const { cookies } = await signIn();
    const res = await reviewStart(cookies, 'drill');
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('drill: 204 while review items are due', async () => {
    const { cookies } = await signIn();
    await lessonWithOneMistake(cookies);
    h().clock.advance(DAY);
    expect((await reviewStart(cookies, 'drill')).statusCode).toBe(204);
  });

  it('review: the due task, presentation 1; the session replaces an unfinished one', async () => {
    const { id, cookies } = await signIn();
    const missed = await lessonWithOneMistake(cookies);
    h().clock.advance(DAY);
    const lesson = await h().app.inject({
      method: 'POST',
      url: `/api/lessons/${L1}/start`,
      headers: csrf,
      cookies,
    });
    const lessonSessionId = StartLessonResponse.parse(lesson.json()).sessionId;

    const s = await reviewStartOk(cookies, 'review');
    expect(s.taskIds).toEqual([missed]);
    expect(s.presentation).toBe(1);
    expect(s.hearts).toEqual({ count: 5, msToNext: null });
    expect(await sessionRow(s.sessionId)).toMatchObject({
      userId: id,
      kind: 'review',
      lessonId: null,
      contentVersion: v1.version,
      status: 'in_progress',
    });
    expect((await sessionRow(lessonSessionId)).status).toBe('abandoned');
  });
});

describe('review session answers', () => {
  it('a right answer moves the item to box 2 due in 3 days; XP = right answers, +1 heart', async () => {
    const { id, cookies } = await signIn();
    const missed = await lessonWithOneMistake(cookies);
    h().clock.advance(DAY); // 2026-10-21
    await setHearts(id, 2);
    const s = await reviewStartOk(cookies, 'review');
    expect(s.hearts).toEqual({ count: 2, msToNext: 30 * MIN });

    const res = await answer(cookies, s.sessionId, {
      taskId: missed,
      presentation: s.presentation,
      answer: rightAnswer(task(missed)),
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = AnswerResponse.parse(res.json());
    expect(r).toMatchObject({
      correct: true,
      status: 'completed',
      nextTaskId: null,
      hearts: { count: 3, msToNext: 30 * MIN },
    });
    expect(r.summary).toEqual({
      kind: 'review',
      mode: 'review',
      correct: 1,
      total: 1,
      heartGained: true,
      xpGained: 1,
      xpToday: 1,
      dailyGoal: 30,
      goalJustReached: false,
      streak: 2,
      streakIncreased: true,
    });

    expect(await itemsOf(id)).toMatchObject([{ taskId: missed, box: 2, dueDate: '2026-10-24' }]);
    expect(await heartsOf(id)).toBe(3);
    const review = (await xpEventsOf(id)).filter((e) => e.source === 'review');
    expect(review).toMatchObject([{ amount: 1, day: '2026-10-21', refId: null }]);
    const [user] = await h().db.select().from(users).where(eq(users.id, id));
    expect(user!.totalXp).toBe(11);
    const [streak] = await h().db.select().from(streaks).where(eq(streaks.userId, id));
    expect(streak).toMatchObject({ current: 2, lastActivityDate: '2026-10-21' });
    expect((await sessionRow(s.sessionId)).status).toBe('completed');
  });

  it('wrong answers keep box 1 (due tomorrow) and cost no hearts; box 3 right → item removed', async () => {
    const { id, cookies } = await signIn();
    const missed = await lessonWithOneMistake(cookies);
    const other = v1.lesson(L1)!.tasks[1]!.id;
    await h()
      .db.insert(reviewItems)
      .values({ userId: id, taskId: other, box: 3, dueDate: '2026-10-20' });
    h().clock.advance(DAY); // 2026-10-21
    const s = await reviewStartOk(cookies, 'review');
    // dueItems order: earlier due date first.
    expect(s.taskIds).toEqual([other, missed]);

    const { responses } = await play(
      cookies,
      s.sessionId,
      s.taskIds[0]!,
      s.presentation,
      (taskId) => taskId === missed,
    );
    expect(responses.map((r) => r.correct)).toEqual([true, false]);
    expect(responses.map((r) => r.presentation)).toEqual([2, 3]);
    expect(responses[0]!.hearts.count).toBe(5);
    expect(responses[1]!.summary).toMatchObject({ correct: 1, total: 2, xpGained: 1 });
    expect(await itemsOf(id)).toMatchObject([{ taskId: missed, box: 1, dueDate: '2026-10-22' }]);
    expect(await heartsOf(id)).toBe(5);
  });

  it('a retried answer returns the same response and credits XP once', async () => {
    const { id, cookies } = await signIn();
    const missed = await lessonWithOneMistake(cookies);
    h().clock.advance(DAY);
    const s = await reviewStartOk(cookies, 'review');
    const body = { taskId: missed, presentation: 1, answer: rightAnswer(task(missed)) };
    const first = await answer(cookies, s.sessionId, body);
    const again = await answer(cookies, s.sessionId, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect((await xpEventsOf(id)).filter((e) => e.source === 'review')).toHaveLength(1);
  });

  it('409 out_of_order for another task or presentation', async () => {
    const { cookies } = await signIn();
    const missed = await lessonWithOneMistake(cookies);
    h().clock.advance(DAY);
    const s = await reviewStartOk(cookies, 'review');
    const stale = await answer(cookies, s.sessionId, {
      taskId: missed,
      presentation: 2,
      answer: rightAnswer(task(missed)),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'out_of_order' } });
  });

  it('409 content_changed when the active version moves on; no XP', async () => {
    const { id, cookies } = await signIn();
    const missed = await lessonWithOneMistake(cookies);
    h().clock.advance(DAY);
    const s = await reviewStartOk(cookies, 'review');
    active = v2;
    const res = await answer(cookies, s.sessionId, {
      taskId: missed,
      presentation: 1,
      answer: rightAnswer(task(missed)),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'content_changed' } });
    expect((await sessionRow(s.sessionId)).status).toBe('content_changed');
    expect((await xpEventsOf(id)).filter((e) => e.source === 'review')).toHaveLength(0);
    expect(await itemsOf(id)).toMatchObject([{ taskId: missed, box: 1 }]);
  });
});

describe('drill sessions', () => {
  it('asks tasks of completed lessons only, never terminal_practice; XP source drill', async () => {
    const { id, cookies } = await signIn();
    const practiceTask = v1.lesson(PRACTICE)!.tasks[0]!;
    expect(practiceTask.type).toBe('terminal_practice');
    await h()
      .db.insert(lessonCompletions)
      .values([
        { userId: id, lessonId: L1, bestMistakes: 0 },
        { userId: id, lessonId: PRACTICE, bestMistakes: 0 },
      ]);
    // A due item of the practice task is not «due» for review/drill either.
    await h()
      .db.insert(reviewItems)
      .values({ userId: id, taskId: practiceTask.id, box: 1, dueDate: '2026-10-20' });
    expect((await reviewStart(cookies, 'review')).statusCode).toBe(204);

    const s = await reviewStartOk(cookies, 'drill');
    const l1Tasks = v1.lesson(L1)!.tasks.map((t) => t.id);
    expect(s.taskIds).toHaveLength(Math.min(10, l1Tasks.length));
    expect(new Set(s.taskIds).size).toBe(s.taskIds.length);
    for (const t of s.taskIds) expect(l1Tasks).toContain(t);
    expect(s.taskIds).not.toContain(practiceTask.id);
    expect((await sessionRow(s.sessionId)).kind).toBe('drill');

    // One wrong answer: the task goes to box 1; right answers leave boxes alone.
    const wrongOne = s.taskIds[0]!;
    const { responses } = await play(
      cookies,
      s.sessionId,
      wrongOne,
      s.presentation,
      (t) => t === wrongOne,
    );
    const last = responses.at(-1)!;
    expect(last.status).toBe('completed');
    expect(last.summary).toMatchObject({
      kind: 'review',
      mode: 'drill',
      correct: s.taskIds.length - 1,
      total: s.taskIds.length,
      xpGained: s.taskIds.length - 1,
    });
    const items = await itemsOf(id);
    expect(items.map((i) => i.taskId).sort()).toEqual([practiceTask.id, wrongOne].sort());
    expect(items.find((i) => i.taskId === wrongOne)).toMatchObject({
      box: 1,
      dueDate: '2026-10-21',
    });
    expect(await xpEventsOf(id)).toMatchObject([{ source: 'drill', amount: s.taskIds.length - 1 }]);
  });
});
