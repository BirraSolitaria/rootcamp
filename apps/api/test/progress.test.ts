import { rm } from 'node:fs/promises';
import { MeDto, ProgressDto } from '@rootcamp/api-contract';
import { lessonCompletions, reviewItems, users } from '@rootcamp/db';
import { trackLessonIds } from '@rootcamp/logic';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { loadContentStore, type ContentStore } from '../src/services/contentStore.js';
import { buildCourse, tempContentDir } from './course.js';
import { TEST_PUBLIC_ORIGIN, useHarness } from './harness.js';

const contentDir = tempContentDir();
const h = useHarness({ contentDir });
const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };

let version: string;
let store: ContentStore;
beforeAll(async () => {
  version = await buildCourse(contentDir);
  store = await loadContentStore(contentDir, version);
}, 60_000);

afterAll(async () => {
  await rm(contentDir, { recursive: true, force: true });
});

/** `content:activate`: stores the version and NOTIFYs the app's holder. */
async function activate() {
  const code = await runCli(['content:activate', version], {
    db: h().db,
    contentDir,
    out: () => {},
    err: () => {},
  });
  expect(code).toBe(0);
}

/** Registers a verified user in `tz`; returns the id and session cookie. */
async function signIn(tz = 'UTC'): Promise<{ id: string; cookies: Record<string, string> }> {
  const res = await h().app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: csrf,
    payload: { email: 'ann@mail.ru', nick: 'ann', password: 'correct horse battery', tz },
  });
  expect(res.statusCode).toBe(201);
  const { user } = res.json() as { user: { id: string } };
  await h().db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  return { id: user.id, cookies: { rc_sid: res.cookies.find((c) => c.name === 'rc_sid')!.value } };
}

/** GET /api/progress, retried while the holder has not caught the NOTIFY yet. */
async function getProgress(cookies: Record<string, string>) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const res = await h().app.inject({ method: 'GET', url: '/api/progress', cookies });
    if (res.statusCode !== 503 || Date.now() > deadline) return res;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function t7Lessons(): string[] {
  return trackLessonIds(store.catalog.tracks.find((t) => t.id === 't7')!);
}

describe('GET /api/progress', () => {
  it('503 while no content version is active', async () => {
    const { cookies } = await signIn();
    const res = await h().app.inject({ method: 'GET', url: '/api/progress', cookies });
    expect(res.statusCode).toBe(503);
  });

  it('new user: nothing completed, nothing due, t7 has 50 lessons', async () => {
    await activate();
    const { cookies } = await signIn();
    const res = await getProgress(cookies);
    expect(res.statusCode).toBe(200);
    const p = ProgressDto.parse(res.json());
    expect(p.completedLessonIds).toEqual([]);
    expect(p.dueCount).toBe(0);
    expect(p.practiceStatuses).toEqual({});
    expect(p.tracks).toContainEqual({
      id: 't7',
      completedLessons: 0,
      totalLessons: 50,
      done: false,
    });
    expect(p.tracks.map((t) => t.id)).toEqual(store.catalog.tracks.map((t) => t.id));
  });

  it('counts completions and due review items of the active version only', async () => {
    await activate();
    const { id, cookies } = await signIn('Asia/Vladivostok');
    const [l1, l2] = t7Lessons();
    const task1 = store.lesson(l1!)!.tasks[0]!.id;
    const task2 = store.lesson(l1!)!.tasks[1]!.id;
    await h()
      .db.insert(lessonCompletions)
      .values([
        { userId: id, lessonId: l1!, bestMistakes: 0 },
        { userId: id, lessonId: l2!, bestMistakes: 1 },
        // Removed from the course: kept in the DB, ignored in counts (spec §4.1).
        { userId: id, lessonId: 't7.s99.l99', bestMistakes: 0 },
      ]);
    // Clock: 2026-10-20T09:00Z = 2026-10-20 19:00 in Vladivostok.
    await h()
      .db.insert(reviewItems)
      .values([
        { userId: id, taskId: task1, box: 1, dueDate: '2026-10-20' }, // due today
        { userId: id, taskId: task2, box: 2, dueDate: '2026-10-21' }, // tomorrow
        { userId: id, taskId: 't7.s99.l99.t01', box: 1, dueDate: '2026-10-01' }, // removed
      ]);
    const p = ProgressDto.parse((await getProgress(cookies)).json());
    expect(p.completedLessonIds.sort()).toEqual([l1!, l2!].sort());
    expect(p.dueCount).toBe(1);
    expect(p.tracks.find((t) => t.id === 't7')).toEqual({
      id: 't7',
      completedLessons: 2,
      totalLessons: 50,
      done: false,
    });
  });
});

describe('GET /api/me rank with content', () => {
  it('sudoer at total_xp=1500 with every t7 lesson completed; user without the track', async () => {
    await activate();
    const { id, cookies } = await signIn();
    await h().db.update(users).set({ totalXp: 1500 }).where(eq(users.id, id));
    const lessons = t7Lessons();
    await h()
      .db.insert(lessonCompletions)
      .values(lessons.slice(1).map((lessonId) => ({ userId: id, lessonId, bestMistakes: 0 })));
    await getProgress(cookies); // waits until the content is loaded

    const before = MeDto.parse(
      (await h().app.inject({ method: 'GET', url: '/api/me', cookies })).json(),
    );
    expect(before.rank).toBe('user');
    expect(before.nextRank).toMatchObject({ next: 'sudoer', tracksNeeded: 1 });

    await h()
      .db.insert(lessonCompletions)
      .values({ userId: id, lessonId: lessons[0]!, bestMistakes: 0 });
    const after = MeDto.parse(
      (await h().app.inject({ method: 'GET', url: '/api/me', cookies })).json(),
    );
    expect(after.rank).toBe('sudoer');

    const p = ProgressDto.parse((await getProgress(cookies)).json());
    expect(p.tracks.find((t) => t.id === 't7')).toMatchObject({ completedLessons: 50, done: true });
  });
});
