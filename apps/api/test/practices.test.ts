// Practice API (plan M4a Task 7, spec §5.1 «Практика», §6.7, §10.2): runs against the in-memory
// sandboxd fake (`createFakeSandboxdClient`), real PostgreSQL and a real pg-boss (stop-solved).
// Course: the M1 `mini` fixture (track t9: l01–l04 + practice inc-demo) with a third goal added,
// so a check reports three goals; reward {base 40, noHintBonus 10, hintCost 5}, 2 hints.
import { rm } from 'node:fs/promises';
import {
  ApiError,
  CheckResponse,
  CreateRunResponse,
  HintResponse,
  PracticeListResponse,
  ProgressDto,
  RunDto,
  TerminalTicketResponse,
} from '@rootcamp/api-contract';
import { verifyTicket } from '@rootcamp/api-contract/ticket';
import {
  lessonCompletions,
  practiceProgress,
  practiceRuns,
  sandboxUsage,
  streaks,
  users,
  xpEvents,
} from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { startBoss } from '../src/jobs/boss.js';
import { HttpError } from '../src/plugins/errors.js';
import {
  loadContentStore,
  type ContentHolder,
  type ContentStore,
} from '../src/services/contentStore.js';
import { createRunSync, STOP_SOLVED_QUEUE } from '../src/services/runs.js';
import {
  createFakeSandboxdClient,
  type FakeSandboxdClient,
} from '../src/services/sandboxdClient.js';
import { buildCourse, MINI_CONTENT, tempContentDir } from './course.js';
import { harnessAppDeps, TEST_PUBLIC_ORIGIN, useHarness } from './harness.js';

const contentDir = tempContentDir();
let store: ContentStore | null = null;
const holder: ContentHolder = {
  current() {
    if (!store) throw new HttpError(503, 'internal', 'course content is not available');
    return store;
  },
  peek: () => store,
  reload: async () => {},
  close: async () => {},
};

let fake: FakeSandboxdClient;
let boss: PgBoss | null = null;
const silentLog = { error: () => {} };
const h = useHarness({
  appFactory: (d) => {
    fake = createFakeSandboxdClient(d.now);
    return buildApp({ ...harnessAppDeps(d), content: holder, sandboxd: fake, boss });
  },
});
const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };
const TICKET_SECRET = 'test-ticket-secret-0123456789abcdef';

const PRACTICE = 'inc-demo';
const LESSONS = ['t9.s01.l01', 't9.s01.l02', 't9.s01.l03', 't9.s01.l04'];
const SEC = 1000;

beforeAll(async () => {
  const hash = await buildCourse(contentDir, MINI_CONTENT, (tree) => {
    const p = tree.practices.find((x) => x.manifest.id === PRACTICE)!;
    p.manifest.goals.push({
      id: 'third-goal',
      title: 'Третья цель',
      check: 'check/third.sh',
      timeoutSec: 5,
    });
    p.files['check/third.sh'] = 'test -f /tmp/third\n';
  });
  store = await loadContentStore(contentDir, hash);
  boss = await startBoss({ DATABASE_URL: h().databaseUrl }, silentLog);
}, 120_000);
beforeEach(async () => {
  await h().sql`delete from pgboss.job`;
});
afterAll(async () => {
  await boss?.stop({ graceful: false, wait: true });
  await rm(contentDir, { recursive: true, force: true });
});

type Cookies = Record<string, string>;

async function signIn(
  nick = 'ann',
  opts: { verified?: boolean; unlocked?: boolean } = {},
): Promise<{ id: string; cookies: Cookies }> {
  const res = await h().app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: csrf,
    payload: { email: `${nick}@mail.ru`, nick, password: 'correct horse battery', tz: 'UTC' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const { user } = res.json() as { user: { id: string } };
  if (opts.verified ?? true) {
    await h().db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  }
  if (opts.unlocked ?? true) {
    await h()
      .db.insert(lessonCompletions)
      .values(
        LESSONS.map((lessonId) => ({
          userId: user.id,
          lessonId,
          firstCompletedAt: new Date(),
          bestMistakes: 0,
        })),
      );
  }
  return { id: user.id, cookies: { rc_sid: res.cookies.find((c) => c.name === 'rc_sid')!.value } };
}

function post(cookies: Cookies, url: string) {
  return h().app.inject({ method: 'POST', url, headers: csrf, cookies });
}
function get(cookies: Cookies, url: string) {
  return h().app.inject({ method: 'GET', url, cookies });
}

async function createRun(cookies: Cookies): Promise<CreateRunResponse> {
  const res = await post(cookies, `/api/practices/${PRACTICE}/runs`);
  expect(res.statusCode, res.body).toBe(201);
  return CreateRunResponse.parse(res.json());
}

function sandboxOf(runId: string): string {
  return fake.latestFor(runId)!.view.sandboxId;
}

/** A run whose sandbox sandboxd reports `ready`. */
async function readyRun(cookies: Cookies): Promise<{ runId: string; sandboxId: string }> {
  const { runId } = await createRun(cookies);
  fake.setState(sandboxOf(runId), 'ready');
  return { runId, sandboxId: sandboxOf(runId) };
}

async function check(cookies: Cookies, runId: string, codes: number[]): Promise<CheckResponse> {
  fake.setGoalExitCodes(codes);
  const res = await post(cookies, `/api/runs/${runId}/check`);
  expect(res.statusCode, res.body).toBe(200);
  return CheckResponse.parse(res.json());
}

async function runRow(runId: string) {
  const [row] = await h().db.select().from(practiceRuns).where(eq(practiceRuns.id, runId));
  return row!;
}

async function getRun(cookies: Cookies, runId: string): Promise<RunDto> {
  const res = await get(cookies, `/api/runs/${runId}`);
  expect(res.statusCode, res.body).toBe(200);
  return RunDto.parse(res.json());
}

function errorOf(res: { json(): unknown }) {
  return ApiError.parse(res.json()).error;
}

describe('GET /api/practices', () => {
  it('lists the practice with its path status, anchor lesson and solved flag', async () => {
    const locked = await signIn('bob', { unlocked: false });
    const lockedList = PracticeListResponse.parse(
      (await get(locked.cookies, '/api/practices')).json(),
    );
    expect(lockedList).toEqual([
      {
        id: PRACTICE,
        title: 'Демо-сервис не запущен',
        track: 't9',
        status: 'locked',
        solved: false,
        anchorLessonId: 't9.s01.l04',
      },
    ]);
    const { cookies } = await signIn();
    const list = PracticeListResponse.parse((await get(cookies, '/api/practices')).json());
    expect(list[0]).toMatchObject({ status: 'available', solved: false });
  });
});

describe('POST /api/practices/:id/runs', () => {
  it('creates a queued run and asks sandboxd for a sandbox from the manifest', async () => {
    const { id, cookies } = await signIn();
    const created = await createRun(cookies);
    expect(created).toEqual({ runId: created.runId, state: 'queued', queuePosition: 1 });

    const sbx = fake.latestFor(created.runId)!;
    expect(sbx.body).toMatchObject({
      runId: created.runId,
      userId: id,
      image: 'rc/linux-base:24.04',
      class: 'light',
      hostname: 'incident-0001',
      title: 'Демо-сервис не запущен',
      setupTimeoutSec: 60,
      ttlMin: 20,
    });
    expect(sbx.body.setupScript.length).toBeGreaterThan(0);
    const row = await runRow(created.runId);
    expect(row).toMatchObject({ status: 'queued', sandboxId: sbx.view.sandboxId, resets: 0 });
    expect(row.contentVersion).toBe(store!.version);
  });

  it('a second run while one is active → 409 run_exists with the active runId', async () => {
    const { cookies } = await signIn();
    const first = await createRun(cookies);
    const res = await post(cookies, `/api/practices/${PRACTICE}/runs`);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: 'run_exists', runId: first.runId });
  });

  it('a practice not yet available → 403 practice_locked; unknown → 404', async () => {
    const { cookies } = await signIn('ann', { unlocked: false });
    const res = await post(cookies, `/api/practices/${PRACTICE}/runs`);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('practice_locked');
    expect((await post(cookies, '/api/practices/nope/runs')).statusCode).toBe(404);
    expect(fake.calls.filter((c) => c.method === 'create')).toEqual([]);
  });

  it('an unconfirmed email → 403 email_unverified', async () => {
    const { cookies } = await signIn('ann', { verified: false });
    const res = await post(cookies, `/api/practices/${PRACTICE}/runs`);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('email_unverified');
  });

  it('sandbox_usage today = 180 min → 403 quota_exceeded (179 still runs)', async () => {
    const { id, cookies } = await signIn();
    await h().db.insert(sandboxUsage).values({ userId: id, day: '2026-10-20', minutes: 180 });
    const res = await post(cookies, `/api/practices/${PRACTICE}/runs`);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('quota_exceeded');

    await h().db.update(sandboxUsage).set({ minutes: 179 }).where(eq(sandboxUsage.userId, id));
    await createRun(cookies);
  });

  it('a 7th run within an hour → 429 rate_limited; an hour later it is allowed', async () => {
    const { cookies } = await signIn();
    for (let i = 0; i < 6; i++) {
      const { runId } = await createRun(cookies);
      expect((await post(cookies, `/api/runs/${runId}/stop`)).statusCode).toBe(204);
      h().clock.advance(SEC);
    }
    const res = await post(cookies, `/api/practices/${PRACTICE}/runs`);
    expect(res.statusCode).toBe(429);
    expect(errorOf(res).code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(3500);
    h().clock.advance(3600 * SEC);
    await createRun(cookies);
  });

  it('sandboxd refusing (queue_full) → 409 queue_full and no run left behind', async () => {
    const { id, cookies } = await signIn();
    fake.failCreate({ status: 409, code: 'queue_full' });
    const res = await post(cookies, `/api/practices/${PRACTICE}/runs`);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('queue_full');
    expect(await h().db.select().from(practiceRuns).where(eq(practiceRuns.userId, id))).toEqual([]);
  });

  it('a stale active run whose sandbox already ended does not block a new run', async () => {
    const { cookies } = await signIn();
    const first = await createRun(cookies);
    fake.setState(sandboxOf(first.runId), 'stopped', 'idle');
    const second = await createRun(cookies);
    expect(second.runId).not.toBe(first.runId);
    expect((await runRow(first.runId)).status).toBe('stopped');
  });
});

describe('GET /api/runs/:runId', () => {
  it('follows the sandbox and maps its state (table of the brief)', async () => {
    const { cookies } = await signIn();
    const { runId } = await createRun(cookies);
    const sid = sandboxOf(runId);
    expect(await getRun(cookies, runId)).toMatchObject({
      runId,
      practiceId: PRACTICE,
      state: 'queued',
      queuePosition: 1,
      goals: [
        { id: 'service-running', passed: false },
        { id: 'file-created', passed: false },
        { id: 'third-goal', passed: false },
      ],
      hintsRevealed: 0,
      hints: [],
      canExtend: false,
      resetsLeft: 3,
      usage: null,
    });
    fake.setState(sid, 'starting');
    expect((await getRun(cookies, runId)).state).toBe('starting');
    fake.setState(sid, 'ready');
    const ready = await getRun(cookies, runId);
    expect(ready).toMatchObject({ state: 'ready', queuePosition: null });
    expect(ready.expiresAt).toBe(new Date(h().clock.now() + 20 * 60 * SEC).toISOString());
    expect(ready.usage).not.toBeNull();
    fake.setState(sid, 'stopped', 'expired');
    const ended = await getRun(cookies, runId);
    expect(ended).toMatchObject({ state: 'expired', stopReason: 'expired' });
    expect((await runRow(runId)).endedAt).not.toBeNull();
    // A finished run keeps its status.
    fake.setState(sid, 'failed', 'crashed');
    expect((await getRun(cookies, runId)).state).toBe('expired');
  });

  it.each([
    ['stopped', 'solved', 'solved'],
    ['stopped', 'queue_timeout', 'queue_timeout'],
    ['stopped', 'idle', 'stopped'],
    ['stopped', 'stopped_by_admin', 'stopped'],
    ['failed', 'setup_failed', 'failed'],
  ] as const)('%s + %s → %s', async (state, reason, expected) => {
    const { cookies } = await signIn();
    const { runId } = await createRun(cookies);
    fake.setState(sandboxOf(runId), state, reason);
    expect((await getRun(cookies, runId)).state).toBe(expected);
  });

  it("another user's run is 404", async () => {
    const ann = await signIn('ann');
    const { runId } = await createRun(ann.cookies);
    const bob = await signIn('bob');
    expect((await get(bob.cookies, `/api/runs/${runId}`)).statusCode).toBe(404);
    expect((await get(bob.cookies, '/api/runs/not-a-uuid')).statusCode).toBe(404);
  });
});

describe('POST /api/runs/:runId/check', () => {
  it('[0,1,0] → not solved; then [0,0,0] → solved, 50 XP, streak, stop-solved in 120 s', async () => {
    const { id, cookies } = await signIn();
    const { runId, sandboxId } = await readyRun(cookies);

    const partial = await check(cookies, runId, [0, 1, 0]);
    expect(partial).toMatchObject({ solved: false, xpAwarded: 0 });
    expect(partial.goals.map((g) => g.passed)).toEqual([true, false, true]);
    expect(partial.goals[1]!.output).toBe('goal file-created failed');
    expect(partial.summary).toBeUndefined();
    const [p1] = await h()
      .db.select()
      .from(practiceProgress)
      .where(eq(practiceProgress.userId, id));
    expect(p1).toMatchObject({ goalsPassed: ['service-running', 'third-goal'], solveCount: 0 });

    h().clock.advance(5 * SEC);
    const solved = await check(cookies, runId, [0, 0, 0]);
    expect(solved).toMatchObject({ solved: true, xpAwarded: 50 });
    expect(solved.summary).toEqual({
      kind: 'practice',
      practiceId: PRACTICE,
      xpGained: 50,
      xpToday: 50,
      dailyGoal: 30,
      goalJustReached: true,
      streak: 1,
      streakIncreased: true,
    });

    expect((await runRow(runId)).status).toBe('solved');
    const [p2] = await h()
      .db.select()
      .from(practiceProgress)
      .where(eq(practiceProgress.userId, id));
    expect(p2).toMatchObject({ solveCount: 1, xpAwarded: 50 });
    expect(p2!.firstSolvedAt).not.toBeNull();
    const xp = await h().db.select().from(xpEvents).where(eq(xpEvents.userId, id));
    expect(xp).toMatchObject([{ amount: 50, source: 'practice', refId: PRACTICE }]);
    const [u] = await h().db.select().from(users).where(eq(users.id, id));
    expect(u!.totalXp).toBe(50);
    const [s] = await h().db.select().from(streaks).where(eq(streaks.userId, id));
    expect(s).toMatchObject({ current: 1, lastActivityDate: '2026-10-20' });

    const jobs = await h().sql<{ data: unknown; delay: number }[]>`
      select data, extract(epoch from (start_after - created_on))::float8 as delay
      from pgboss.job where name = ${STOP_SOLVED_QUEUE}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ runId, sandboxId });
    expect(jobs[0]!.delay).toBeGreaterThan(115);
    expect(jobs[0]!.delay).toBeLessThan(125);

    // The run screen and the path now show it solved; a re-check awards nothing.
    expect((await getRun(cookies, runId)).state).toBe('solved');
    const progress = ProgressDto.parse((await get(cookies, '/api/progress')).json());
    expect(progress.practiceStatuses[PRACTICE]).toBe('solved');
    const list = PracticeListResponse.parse((await get(cookies, '/api/practices')).json());
    expect(list[0]).toMatchObject({ status: 'solved', solved: true });
    h().clock.advance(5 * SEC);
    expect(await check(cookies, runId, [0, 0, 0])).toMatchObject({ solved: true, xpAwarded: 0 });
    expect(await h().db.select().from(xpEvents).where(eq(xpEvents.userId, id))).toHaveLength(1);
  });

  it('2 hints opened in an earlier run → first solve 30; a repeat solve → 10', async () => {
    const { cookies } = await signIn();
    const first = await readyRun(cookies);
    const hint1 = HintResponse.parse(
      (await post(cookies, `/api/runs/${first.runId}/hints`)).json(),
    );
    expect(hint1).toEqual({
      index: 0,
      text: 'Посмотри, какой процесс должен писать отчёт.',
      hintsRevealed: 1,
    });
    const hint2 = HintResponse.parse(
      (await post(cookies, `/api/runs/${first.runId}/hints`)).json(),
    );
    expect(hint2).toMatchObject({ index: 1, hintsRevealed: 2 });
    const none = await post(cookies, `/api/runs/${first.runId}/hints`);
    expect(none.statusCode).toBe(409);
    expect((await post(cookies, `/api/runs/${first.runId}/stop`)).statusCode).toBe(204);
    expect(fake.latestFor(first.runId)!.removedWith).toBe('stopped_by_user');
    expect((await runRow(first.runId)).status).toBe('stopped');

    const second = await readyRun(cookies);
    const dto = await getRun(cookies, second.runId);
    expect(dto).toMatchObject({ hintsRevealed: 2 });
    expect(dto.hints).toHaveLength(2);
    expect((await check(cookies, second.runId, [0, 0, 0])).xpAwarded).toBe(30);

    // The solved run's sandbox still waits for stop-solved: a new run releases it first.
    h().clock.advance(5 * SEC);
    const third = await readyRun(cookies);
    expect(fake.latestFor(second.runId)!.removedWith).toBe('solved');
    const repeat = await check(cookies, third.runId, [0, 0, 0]);
    expect(repeat).toMatchObject({ solved: true, xpAwarded: 10 });
    expect(repeat.summary?.xpGained).toBe(10);
  });

  it('a second check within 5 s → 429 rate_limited', async () => {
    const { cookies } = await signIn();
    const { runId } = await readyRun(cookies);
    await check(cookies, runId, [1, 1, 1]);
    h().clock.advance(2 * SEC);
    const res = await post(cookies, `/api/runs/${runId}/check`);
    expect(res.statusCode).toBe(429);
    expect(errorOf(res).code).toBe('rate_limited');
    h().clock.advance(3 * SEC);
    await check(cookies, runId, [1, 1, 1]);
  });

  it('a sandbox that is not ready yet → 409, no exec-checks call', async () => {
    const { cookies } = await signIn();
    const { runId } = await createRun(cookies);
    expect((await post(cookies, `/api/runs/${runId}/check`)).statusCode).toBe(409);
    expect(fake.calls.filter((c) => c.method === 'execChecks')).toEqual([]);
  });
});

describe('reset, extend, stop, terminal ticket', () => {
  it('reset recreates the sandbox under the same run, at most 3 times', async () => {
    const { cookies } = await signIn();
    const { runId } = await readyRun(cookies);
    for (let i = 1; i <= 3; i++) {
      const before = sandboxOf(runId);
      const res = await post(cookies, `/api/runs/${runId}/reset`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ state: 'starting' });
      expect(fake.sandboxes.get(before)!.removedWith).toBe('reset');
      const after = sandboxOf(runId);
      expect(after).not.toBe(before);
      expect((await runRow(runId)).sandboxId).toBe(after);
      fake.setState(after, 'ready');
    }
    expect((await getRun(cookies, runId)).resetsLeft).toBe(0);
    const res = await post(cookies, `/api/runs/${runId}/reset`);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('reset_limit');
    expect(fake.calls.filter((c) => c.method === 'create')).toHaveLength(4);
  });

  it('extend passes sandboxd through; extend_not_allowed when it refuses', async () => {
    const { cookies } = await signIn();
    const { runId, sandboxId } = await readyRun(cookies);
    const refused = await post(cookies, `/api/runs/${runId}/extend`);
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).code).toBe('extend_not_allowed');
    fake.patch(sandboxId, { canExtend: true });
    expect((await getRun(cookies, runId)).canExtend).toBe(true);
    const ok = await post(cookies, `/api/runs/${runId}/extend`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({
      expiresAt: new Date(h().clock.now() + 35 * 60 * SEC).toISOString(),
    });
  });

  it('terminal-ticket: ws(s) URL from PUBLIC_ORIGIN, signed, exp = now + 30 s', async () => {
    const { id, cookies } = await signIn();
    const queued = await createRun(cookies);
    expect((await post(cookies, `/api/runs/${queued.runId}/terminal-ticket`)).statusCode).toBe(409);
    fake.setState(sandboxOf(queued.runId), 'ready');
    const res = await post(cookies, `/api/runs/${queued.runId}/terminal-ticket`);
    expect(res.statusCode, res.body).toBe(200);
    const { ticket, url } = TerminalTicketResponse.parse(res.json());
    expect(url).toBe(`ws://127.0.0.1:8080/ws/terminal?ticket=${encodeURIComponent(ticket)}`);
    const payload = verifyTicket(ticket, TICKET_SECRET, h().clock.now());
    expect(payload).toMatchObject({
      runId: queued.runId,
      userId: id,
      sandboxId: sandboxOf(queued.runId),
      exp: h().clock.now() + 30 * SEC,
    });
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    const again = TerminalTicketResponse.parse(
      (await post(cookies, `/api/runs/${queued.runId}/terminal-ticket`)).json(),
    );
    expect(verifyTicket(again.ticket, TICKET_SECRET, h().clock.now()).jti).not.toBe(payload.jti);
  });
});

describe('background jobs', () => {
  it('runs-sync ends runs from passive reads; stop-solved removes with reason solved', async () => {
    const { cookies } = await signIn();
    const { runId, sandboxId } = await readyRun(cookies);
    fake.setState(sandboxId, 'stopped', 'idle');
    const sync = createRunSync({ db: h().db, sandboxd: fake, now: h().clock.now });
    expect(await sync.syncOpenRuns()).toEqual({ checked: 1, changed: 1 });
    expect((await runRow(runId)).status).toBe('stopped');
    const reads = fake.calls.filter((c) => c.method === 'get' && c.id === sandboxId);
    expect(reads.at(-1)!.arg).toEqual({ passive: true });

    h().clock.advance(5 * SEC);
    const next = await readyRun(cookies);
    await sync.stopSolved({ runId: next.runId, sandboxId: next.sandboxId });
    expect(fake.latestFor(next.runId)!.removedWith).toBe('solved');
    await sync.stopSolved({ runId: next.runId, sandboxId: '00000000-0000-4000-8000-000000000000' });
  });

  it('without sandboxd: run routes 503, listing works, jobs are no-ops', async () => {
    const app = await buildApp({ ...harnessAppDeps(h().deps), content: holder });
    try {
      const { cookies } = await signIn();
      const res = await app.inject({
        method: 'POST',
        url: `/api/practices/${PRACTICE}/runs`,
        headers: csrf,
        cookies,
      });
      expect(res.statusCode).toBe(503);
      expect(errorOf(res).code).toBe('queue_full');
      const list = await app.inject({ method: 'GET', url: '/api/practices', cookies });
      expect(list.statusCode).toBe(200);
      const sync = createRunSync({ db: h().db, now: h().clock.now });
      expect(await sync.syncOpenRuns()).toEqual({ checked: 0, changed: 0 });
      await sync.stopSolved({ runId: 'x', sandboxId: 'y' });
    } finally {
      await app.close();
    }
  });
});
