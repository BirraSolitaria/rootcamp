// Lesson sessions (plan M3 Task 5, spec §5.1 «Сессии обучения», §9): start, answer, complete,
// abandon. Runs on the M1 `mini` fixture course (track t9: l01–l04 + practice inc-demo), served
// through a holder the tests switch between two built versions.
import { rm } from 'node:fs/promises';
import { AnswerResponse, StartLessonResponse, type UserAnswer } from '@rootcamp/api-contract';
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
  expect(v2.version).not.toBe(v1.version);
}, 60_000);
beforeEach(() => {
  active = v1;
});
afterAll(async () => {
  await rm(contentDir, { recursive: true, force: true });
});

const L1 = 't9.s01.l01';
const L2 = 't9.s01.l02';
const MIN = 60_000;

type Cookies = Record<string, string>;

/** Registers a verified user in `tz`; returns the id and session cookie. */
async function signIn(tz = 'UTC', nick = 'ann'): Promise<{ id: string; cookies: Cookies }> {
  const res = await h().app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: csrf,
    payload: { email: `${nick}@mail.ru`, nick, password: 'correct horse battery', tz },
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

function start(cookies: Cookies, lessonId: string) {
  return h().app.inject({
    method: 'POST',
    url: `/api/lessons/${lessonId}/start`,
    headers: csrf,
    cookies,
  });
}

async function startOk(cookies: Cookies, lessonId: string): Promise<StartLessonResponse> {
  const res = await start(cookies, lessonId);
  expect(res.statusCode, res.body).toBe(200);
  return StartLessonResponse.parse(res.json());
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

/** A client: follows `nextTaskId`/`presentation`, answering wrong where `wrong(taskId, n)`. */
async function play(
  cookies: Cookies,
  s: StartLessonResponse,
  opts: { wrong?: (taskId: string) => boolean; steps?: number; beforeEach?: () => void } = {},
): Promise<{ responses: AnswerResponse[]; shown: string[] }> {
  let taskId: string | null = s.queue[0]!;
  let presentation = s.presentation;
  const responses: AnswerResponse[] = [];
  const shown: string[] = [];
  while (taskId !== null && responses.length < (opts.steps ?? Infinity)) {
    opts.beforeEach?.();
    shown.push(taskId);
    const t = task(taskId);
    const wrong = opts.wrong?.(taskId) ?? false;
    const res = await answer(cookies, s.sessionId, {
      taskId,
      presentation,
      answer: wrong ? wrongAnswer(t) : rightAnswer(t),
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = AnswerResponse.parse(res.json());
    responses.push(r);
    taskId = r.nextTaskId;
    presentation = r.presentation;
  }
  return { responses, shown };
}

async function sessionRow(id: string) {
  const [row] = await h().db.select().from(learningSessions).where(eq(learningSessions.id, id));
  return row!;
}

async function heartsOf(userId: string) {
  const [row] = await h().db.select().from(hearts).where(eq(hearts.userId, userId));
  return row!.count;
}

async function xpOf(userId: string) {
  const events = await h().db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  const [user] = await h().db.select().from(users).where(eq(users.id, userId));
  return { events, totalXp: user!.totalXp, rank: user!.rank };
}

describe('POST /api/lessons/:lessonId/start', () => {
  it('503 while no content is active', async () => {
    const { cookies } = await signIn();
    active = null;
    expect((await start(cookies, L1)).statusCode).toBe(503);
  });

  it('starts the current lesson: whole queue, presentation 1, full hearts', async () => {
    const { cookies } = await signIn();
    const s = await startOk(cookies, L1);
    expect(s.queue).toEqual(v1.lesson(L1)!.tasks.map((t) => t.id));
    expect(s.presentation).toBe(1);
    expect(s.hearts).toEqual({ count: 5, msToNext: null });
    expect(s.contentVersion).toBe(v1.version);
    const row = await sessionRow(s.sessionId);
    expect(row).toMatchObject({
      kind: 'lesson',
      lessonId: L1,
      contentVersion: v1.version,
      status: 'in_progress',
    });
  });

  it('403 locked for a lesson after the current one; 404 for unknown ids and practices', async () => {
    const { cookies } = await signIn();
    const locked = await start(cookies, L2);
    expect(locked.statusCode).toBe(403);
    expect(locked.json()).toMatchObject({ error: { code: 'locked' } });
    expect((await start(cookies, 't9.s01.l99')).statusCode).toBe(404);
    expect((await start(cookies, 't9.s01.p-inc-demo')).statusCode).toBe(404);
  });
});

describe('POST /api/sessions/:id/answer', () => {
  it('perfect lesson: 15 XP, streak 1, lesson completed, the next one becomes current', async () => {
    const { id, cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const { responses, shown } = await play(cookies, s);
    expect(shown).toEqual(s.queue);
    expect(responses.every((r) => r.correct)).toBe(true);
    expect(responses.slice(0, -1).every((r) => r.status === 'in_progress')).toBe(true);
    const last = responses.at(-1)!;
    expect(last).toMatchObject({ status: 'completed', nextTaskId: null });
    expect(last.summary).toEqual({
      kind: 'lesson',
      lessonId: L1,
      mistakes: 0,
      perfect: true,
      xpGained: 15,
      xpToday: 15,
      dailyGoal: 30,
      goalJustReached: false,
      streak: 1,
      streakIncreased: true,
    });

    const xp = await xpOf(id);
    expect(xp.events).toHaveLength(1);
    expect(xp.events[0]).toMatchObject({
      amount: 15,
      source: 'lesson',
      refId: L1,
      day: '2026-10-20',
    });
    expect(xp.totalXp).toBe(15);
    const [streak] = await h().db.select().from(streaks).where(eq(streaks.userId, id));
    expect(streak).toMatchObject({ current: 1, best: 1, lastActivityDate: '2026-10-20' });
    const completions = await h()
      .db.select()
      .from(lessonCompletions)
      .where(eq(lessonCompletions.userId, id));
    expect(completions).toMatchObject([{ lessonId: L1, times: 1, bestMistakes: 0 }]);
    expect((await sessionRow(s.sessionId)).status).toBe('completed');

    const progress = await h().app.inject({ method: 'GET', url: '/api/progress', cookies });
    expect(progress.json()).toMatchObject({ completedLessonIds: [L1] });
    await startOk(cookies, L2);
  });

  it('a retried final answer returns the same summary and credits XP once', async () => {
    const { id, cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const n = s.queue.length;
    const { responses } = await play(cookies, s, { steps: n - 1 });
    const prev = responses.at(-1)!;
    const body = {
      taskId: prev.nextTaskId!,
      presentation: prev.presentation,
      answer: rightAnswer(task(prev.nextTaskId!)),
    };
    const first = await answer(cookies, s.sessionId, body);
    const again = await answer(cookies, s.sessionId, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ status: 'completed' });
    const xp = await xpOf(id);
    expect(xp.events).toHaveLength(1);
    expect(xp.totalXp).toBe(15);
  });

  it('replaying a completed lesson counts it again with the best mistakes kept', async () => {
    const { id, cookies } = await signIn();
    await play(cookies, await startOk(cookies, L1), {
      wrong: (() => {
        let first = true;
        return () => {
          const w = first;
          first = false;
          return w;
        };
      })(),
    });
    await play(cookies, await startOk(cookies, L1));
    const completions = await h()
      .db.select()
      .from(lessonCompletions)
      .where(eq(lessonCompletions.userId, id));
    expect(completions).toMatchObject([{ lessonId: L1, times: 2, bestMistakes: 0 }]);
    expect((await xpOf(id)).totalXp).toBe(25);
  });

  it('one mistake: heart 4, review item in box 1, task requeued at the end, 10 XP', async () => {
    const { id, cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const first = s.queue[0]!;
    let missed = false;
    const { responses, shown } = await play(cookies, s, {
      wrong: (taskId) => {
        if (taskId !== first || missed) return false;
        missed = true;
        return true;
      },
    });
    expect(responses[0]).toMatchObject({
      correct: false,
      correctAnswerText: 'Запущенный экземпляр образа',
      hearts: { count: 4, msToNext: 30 * MIN },
      status: 'in_progress',
      nextTaskId: s.queue[1],
      presentation: 2,
    });
    expect(shown).toEqual([...s.queue, first]);
    expect(responses.at(-1)!.summary).toMatchObject({ xpGained: 10, mistakes: 1, perfect: false });

    const items = await h().db.select().from(reviewItems).where(eq(reviewItems.userId, id));
    expect(items).toMatchObject([{ taskId: first, box: 1, dueDate: '2026-10-21' }]);
    expect(await heartsOf(id)).toBe(4);
    const xp = await xpOf(id);
    expect(xp.events.map((e) => e.amount)).toEqual([10]);
    const [completion] = await h()
      .db.select()
      .from(lessonCompletions)
      .where(eq(lessonCompletions.userId, id));
    expect(completion).toMatchObject({ bestMistakes: 1 });
  });

  it('five mistakes: out_of_hearts closes the session; the next start is 403 no_hearts', async () => {
    const { id, cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const { responses } = await play(cookies, s, { wrong: () => true });
    expect(responses).toHaveLength(5);
    expect(responses.map((r) => r.hearts.count)).toEqual([4, 3, 2, 1, 0]);
    expect(responses.at(-1)).toMatchObject({
      status: 'out_of_hearts',
      nextTaskId: null,
      hearts: { count: 0, msToNext: 30 * MIN },
    });
    expect(responses.at(-1)!.summary).toBeUndefined();
    expect((await sessionRow(s.sessionId)).status).toBe('out_of_hearts');
    expect(await heartsOf(id)).toBe(0);
    expect((await xpOf(id)).events).toHaveLength(0);

    const again = await start(cookies, L1);
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject({ error: { code: 'no_hearts' } });

    // A heart regenerates in 30 minutes.
    h().clock.advance(30 * MIN);
    const s2 = await startOk(cookies, L1);
    expect(s2.hearts).toEqual({ count: 1, msToNext: 30 * MIN });
  });

  it('409 out_of_order for another task or a stale presentation; nothing is charged', async () => {
    const { id, cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const [t1, t2] = s.queue as [string, string];
    const other = await answer(cookies, s.sessionId, {
      taskId: t2,
      presentation: 1,
      answer: wrongAnswer(task(t2)),
    });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: { code: 'out_of_order' } });
    const stale = await answer(cookies, s.sessionId, {
      taskId: t1,
      presentation: 2,
      answer: wrongAnswer(task(t1)),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'out_of_order' } });
    expect(await heartsOf(id)).toBe(5);
    const ok = await answer(cookies, s.sessionId, {
      taskId: t1,
      presentation: 1,
      answer: rightAnswer(task(t1)),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('400 validation for a malformed body', async () => {
    const { cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const res = await h().app.inject({
      method: 'POST',
      url: `/api/sessions/${s.sessionId}/answer`,
      headers: csrf,
      cookies,
      payload: { taskId: s.queue[0], answer: { type: 'single_choice' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
  });

  it('404 for an unknown session or another user’s session', async () => {
    const { cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const body = {
      taskId: s.queue[0]!,
      presentation: 1,
      answer: rightAnswer(task(s.queue[0]!)),
    };
    const unknown = await answer(cookies, '00000000-0000-4000-8000-000000000000', body);
    expect(unknown.statusCode).toBe(404);
    expect((await answer(cookies, 'not-a-uuid', body)).statusCode).toBe(404);
    const bob = await signIn('UTC', 'bob');
    expect((await answer(bob.cookies, s.sessionId, body)).statusCode).toBe(404);
  });

  it('409 content_changed when the active version moves on; no XP, no penalty', async () => {
    const { id, cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const { responses } = await play(cookies, s, { steps: 1 });
    const next = responses[0]!;
    active = v2;
    const body = {
      taskId: next.nextTaskId!,
      presentation: next.presentation,
      answer: wrongAnswer(task(next.nextTaskId!)),
    };
    const res = await answer(cookies, s.sessionId, body);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'content_changed' } });
    expect((await sessionRow(s.sessionId)).status).toBe('content_changed');
    expect(await heartsOf(id)).toBe(5);
    const xp = await xpOf(id);
    expect(xp.events).toHaveLength(0);
    expect(xp.totalXp).toBe(0);
    // A closed content_changed session keeps answering with that code.
    const again = await answer(cookies, s.sessionId, body);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'content_changed' } });

    // The client restarts the lesson on the new version.
    const s2 = await startOk(cookies, L1);
    expect(s2.contentVersion).toBe(v2.version);
    expect((await sessionRow(s2.sessionId)).contentVersion).toBe(v2.version);
  });

  it('a retried answer (same taskId and presentation) returns the same response, one heart', async () => {
    const { id, cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const body = {
      taskId: s.queue[0]!,
      presentation: s.presentation,
      answer: wrongAnswer(task(s.queue[0]!)),
    };
    const first = await answer(cookies, s.sessionId, body);
    const again = await answer(cookies, s.sessionId, body);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await heartsOf(id)).toBe(4);
    expect(await h().db.select().from(reviewItems)).toHaveLength(1);

    // A concurrent duplicate is serialised by the row locks: still one heart.
    const r2 = AnswerResponse.parse(first.json());
    const body2 = {
      taskId: r2.nextTaskId!,
      presentation: r2.presentation,
      answer: wrongAnswer(task(r2.nextTaskId!)),
    };
    const [a, b] = await Promise.all([
      answer(cookies, s.sessionId, body2),
      answer(cookies, s.sessionId, body2),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(await heartsOf(id)).toBe(3);
  });

  it('a start in another tab closes the old session: its answers get 409 session_closed', async () => {
    const { cookies } = await signIn();
    const tabA = await startOk(cookies, L1);
    const tabB = await startOk(cookies, L1);
    expect(tabB.sessionId).not.toBe(tabA.sessionId);
    const body = {
      taskId: tabA.queue[0]!,
      presentation: 1,
      answer: rightAnswer(task(tabA.queue[0]!)),
    };
    const old = await answer(cookies, tabA.sessionId, body);
    expect(old.statusCode).toBe(409);
    expect(old.json()).toMatchObject({ error: { code: 'session_closed' } });
    expect((await sessionRow(tabA.sessionId)).status).toBe('abandoned');
    expect((await answer(cookies, tabB.sessionId, body)).statusCode).toBe(200);
  });

  it('XP goes to the completion day in the user’s zone (Asia/Vladivostok)', async () => {
    const { id, cookies } = await signIn('Asia/Vladivostok');
    h().clock.set(Date.parse('2026-10-20T13:50:00Z'));
    const s = await startOk(cookies, L1);
    // All but the last answer at 23:59:59 local time…
    const { responses } = await play(cookies, s, {
      steps: s.queue.length - 1,
      beforeEach: () => h().clock.set(Date.parse('2026-10-20T13:59:59Z')),
    });
    // …and the last one after midnight: 2026-10-20T14:30Z = 2026-10-21 00:30 in Vladivostok.
    h().clock.set(Date.parse('2026-10-20T14:30:00Z'));
    const prev = responses.at(-1)!;
    const res = await answer(cookies, s.sessionId, {
      taskId: prev.nextTaskId!,
      presentation: prev.presentation,
      answer: rightAnswer(task(prev.nextTaskId!)),
    });
    expect(AnswerResponse.parse(res.json()).status).toBe('completed');
    const xp = await xpOf(id);
    expect(xp.events.map((e) => e.day)).toEqual(['2026-10-21']);
    const [streak] = await h().db.select().from(streaks).where(eq(streaks.userId, id));
    expect(streak!.lastActivityDate).toBe('2026-10-21');
  });

  it('raises the stored rank when total_xp crosses 200', async () => {
    const { id, cookies } = await signIn();
    await h()
      .db.insert(xpEvents)
      .values({ userId: id, amount: 190, source: 'lesson', refId: 'old', day: '2026-10-19' });
    await h().db.update(users).set({ totalXp: 190 }).where(eq(users.id, id));
    await play(cookies, await startOk(cookies, L1));
    const xp = await xpOf(id);
    expect(xp.totalXp).toBe(205);
    expect(xp.rank).toBe('user');
  });
});

describe('POST /api/sessions/:id/abandon', () => {
  it('closes the session without reward; answers then get session_closed', async () => {
    const { id, cookies } = await signIn();
    const s = await startOk(cookies, L1);
    const res = await h().app.inject({
      method: 'POST',
      url: `/api/sessions/${s.sessionId}/abandon`,
      headers: csrf,
      cookies,
    });
    expect(res.statusCode).toBe(204);
    expect((await sessionRow(s.sessionId)).status).toBe('abandoned');
    const after = await answer(cookies, s.sessionId, {
      taskId: s.queue[0]!,
      presentation: 1,
      answer: rightAnswer(task(s.queue[0]!)),
    });
    expect(after.statusCode).toBe(409);
    expect(after.json()).toMatchObject({ error: { code: 'session_closed' } });
    expect((await xpOf(id)).events).toHaveLength(0);

    const unknown = await h().app.inject({
      method: 'POST',
      url: '/api/sessions/00000000-0000-4000-8000-000000000000/abandon',
      headers: csrf,
      cookies,
    });
    expect(unknown.statusCode).toBe(404);
  });
});
