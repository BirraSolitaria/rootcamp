import { MeDto, UserDto } from '@rootcamp/api-contract';
import { hearts, sessions, streaks, users, xpEvents } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { TEST_PUBLIC_ORIGIN, useHarness, type MailpitMessage } from './harness.js';

const h = useHarness();

const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };

const ann = {
  email: 'ann@mail.ru',
  nick: 'ann',
  password: 'correct horse battery',
  tz: 'Europe/Moscow',
};

type Cookies = Record<string, string>;

function errorOf(res: { json(): unknown }) {
  return (res.json() as { error: { code: string; message: string } }).error;
}

function sessionCookie(res: { cookies: { name: string; value: string }[] }): Cookies {
  const c = res.cookies.find((x) => x.name === 'rc_sid');
  if (!c) throw new Error('no rc_sid cookie');
  return { rc_sid: c.value };
}

function verifyTokenFrom(msg: MailpitMessage): string {
  const m = /\/verify\?token=([A-Za-z0-9_-]+)/.exec(msg.text);
  if (!m) throw new Error(`no verify link in: ${msg.text}`);
  return m[1]!;
}

function post(url: string, payload?: object, cookies: Cookies = {}) {
  return h().app.inject({ method: 'POST', url, headers: csrf, payload, cookies });
}

function getMe(cookies: Cookies) {
  return h().app.inject({ method: 'GET', url: '/api/me', cookies });
}

function patchMe(payload: object, cookies: Cookies) {
  return h().app.inject({ method: 'PATCH', url: '/api/me', headers: csrf, payload, cookies });
}

/** Registers ann; returns her id and session cookie. */
async function signUp(body: typeof ann = ann): Promise<{ id: string; cookies: Cookies }> {
  const res = await post('/api/auth/register', body);
  expect(res.statusCode).toBe(201);
  const { user } = res.json() as { user: { id: string } };
  return { id: user.id, cookies: sessionCookie(res) };
}

async function markVerified(id: string) {
  await h()
    .db.update(users)
    .set({ emailVerifiedAt: new Date(h().clock.now()) })
    .where(eq(users.id, id));
}

describe('GET /api/me', () => {
  it('requires a session', async () => {
    const res = await getMe({});
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthorized');
  });

  it('fresh (unverified) user: full MeDto with defaults', async () => {
    const { cookies } = await signUp();
    const res = await getMe(cookies);
    expect(res.statusCode).toBe(200);
    const me = MeDto.parse(res.json());
    expect(me).toEqual({
      user: expect.objectContaining({ email: 'ann@mail.ru', emailVerified: false }),
      hearts: { count: 5, msToNext: null },
      streak: { current: 0, best: 0 },
      xpToday: 0,
      dailyGoal: 30,
      rank: 'guest',
      nextRank: { next: 'user', xpNeeded: 200, tracksNeeded: 0 },
    });
  });

  it('regenerates hearts before answering and stores the result', async () => {
    const { id, cookies } = await signUp();
    const now = h().clock.now();
    await h()
      .db.update(hearts)
      .set({ count: 2, lastRegenAt: new Date(now - 3_600_000) })
      .where(eq(hearts.userId, id));

    const me = MeDto.parse((await getMe(cookies)).json());
    expect(me.hearts).toEqual({ count: 4, msToNext: 1_800_000 });
    const [row] = await h().db.select().from(hearts).where(eq(hearts.userId, id));
    expect(row).toMatchObject({ count: 4, lastRegenAt: new Date(now) });
  });

  it('a streak whose last activity was the day before yesterday is reset to 0 (best kept)', async () => {
    const { id, cookies } = await signUp();
    // Clock: 2026-10-20 12:00 MSK → day before yesterday is 2026-10-18.
    await h()
      .db.update(streaks)
      .set({ current: 3, best: 5, lastActivityDate: '2026-10-18' })
      .where(eq(streaks.userId, id));

    const me = MeDto.parse((await getMe(cookies)).json());
    expect(me.streak).toEqual({ current: 0, best: 5 });
    const [row] = await h().db.select().from(streaks).where(eq(streaks.userId, id));
    expect(row).toMatchObject({ current: 0, best: 5, lastActivityDate: '2026-10-18' });
  });

  it('a streak active yesterday is kept', async () => {
    const { id, cookies } = await signUp();
    await h()
      .db.update(streaks)
      .set({ current: 3, best: 5, lastActivityDate: '2026-10-19' })
      .where(eq(streaks.userId, id));
    const me = MeDto.parse((await getMe(cookies)).json());
    expect(me.streak).toEqual({ current: 3, best: 5 });
  });

  it("xpToday sums only today's xp_events (user's zone); rank/nextRank follow totalXp", async () => {
    const { id, cookies } = await signUp();
    await h()
      .db.insert(xpEvents)
      .values([
        { userId: id, amount: 10, source: 'lesson', day: '2026-10-20' },
        { userId: id, amount: 15, source: 'lesson', day: '2026-10-20' },
        { userId: id, amount: 200, source: 'lesson', day: '2026-10-19' },
      ]);
    await h().db.update(users).set({ totalXp: 225, rank: 'user' }).where(eq(users.id, id));

    const me = MeDto.parse((await getMe(cookies)).json());
    expect(me.xpToday).toBe(25);
    expect(me.rank).toBe('user');
    expect(me.user.totalXp).toBe(225);
    expect(me.nextRank).toEqual({ next: 'sudoer', xpNeeded: 1275, tracksNeeded: 1 });
  });
});

describe('PATCH /api/me', () => {
  it('updates tz and reminder settings; reminderTime is HH:MM', async () => {
    const { cookies } = await signUp();
    const res = await patchMe(
      { tz: 'Asia/Yekaterinburg', reminderEnabled: false, reminderTime: '07:30' },
      cookies,
    );
    expect(res.statusCode).toBe(200);
    const { user } = res.json() as { user: unknown };
    expect(UserDto.parse(user)).toMatchObject({
      tz: 'Asia/Yekaterinburg',
      reminderEnabled: false,
      reminderTime: '07:30',
    });
    const me = MeDto.parse((await getMe(cookies)).json());
    expect(me.user.reminderTime).toBe('07:30');
  });

  it('unknown tz or bad reminderTime → 400 validation', async () => {
    const { cookies } = await signUp();
    for (const body of [{ tz: 'Mars/Base' }, { reminderTime: '24:00' }]) {
      const res = await patchMe(body, cookies);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation');
    }
  });

  it('unverified: email change sends a letter to the new address, old link → token_invalid', async () => {
    const { cookies } = await signUp();
    const [oldMsg] = await h().mail.waitForMessages('ann@mail.ru');

    const res = await patchMe({ email: 'new@x.ru' }, cookies);
    expect(res.statusCode).toBe(200);
    const { user } = res.json() as { user: unknown };
    expect(UserDto.parse(user)).toMatchObject({ email: 'new@x.ru', emailVerified: false });

    const [newMsg] = await h().mail.waitForMessages('new@x.ru');
    const old = await post('/api/auth/verify', { token: verifyTokenFrom(oldMsg!) });
    expect(old.statusCode).toBe(400);
    expect(errorOf(old).code).toBe('token_invalid');

    const ok = await post('/api/auth/verify', { token: verifyTokenFrom(newMsg!) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { user: { email: string } }).user.email).toBe('new@x.ru');
  });

  it('second email change within a minute → 429 rate_limited, no second letter', async () => {
    const { cookies } = await signUp();
    expect((await patchMe({ email: 'new@x.ru' }, cookies)).statusCode).toBe(200);
    await h().mail.waitForMessages('new@x.ru');

    const res = await patchMe({ email: 'other@x.ru' }, cookies);
    expect(res.statusCode).toBe(429);
    expect(errorOf(res).code).toBe('rate_limited');
    const [u] = await h().db.select().from(users);
    expect(u!.email).toBe('new@x.ru');

    h().clock.advance(60_000);
    expect((await patchMe({ email: 'other@x.ru' }, cookies)).statusCode).toBe(200);
    await h().mail.waitForMessages('other@x.ru');
    // The rejected attempt sent nothing: only the letter after the minute arrived.
    expect(await h().mail.messages('other@x.ru')).toHaveLength(1);
  });

  it('email change shares the budget with resend-verification', async () => {
    const { cookies } = await signUp();
    expect((await post('/api/auth/resend-verification', undefined, cookies)).statusCode).toBe(204);
    const res = await patchMe({ email: 'new@x.ru' }, cookies);
    expect(res.statusCode).toBe(429);
    expect(errorOf(res).code).toBe('rate_limited');
    expect(await h().mail.messages('new@x.ru')).toEqual([]);
  });

  it('the current email (any case) is a no-op: no letter, old link still valid', async () => {
    const { cookies } = await signUp();
    const [msg] = await h().mail.waitForMessages('ann@mail.ru');

    const res = await patchMe({ email: 'Ann@Mail.RU', reminderEnabled: false }, cookies);
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as { user: { email: string; reminderEnabled: boolean } }).user,
    ).toMatchObject({ email: 'ann@mail.ru', reminderEnabled: false });
    // Not limited either: the no-op did not spend the budget.
    expect((await patchMe({ email: 'ann@mail.ru' }, cookies)).statusCode).toBe(200);
    expect(await h().mail.messages('ann@mail.ru')).toHaveLength(1);
    const ok = await post('/api/auth/verify', { token: verifyTokenFrom(msg!) });
    expect(ok.statusCode).toBe(200);
  });

  it('verified: email change → 409 email_already_verified, nothing changes', async () => {
    const { id, cookies } = await signUp();
    await markVerified(id);
    const res = await patchMe({ email: 'new@x.ru', tz: 'UTC' }, cookies);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('email_already_verified');
    const [u] = await h().db.select().from(users).where(eq(users.id, id));
    expect(u).toMatchObject({ email: 'ann@mail.ru', tz: 'Europe/Moscow' });
  });

  it("someone else's email → 409 email_taken", async () => {
    await signUp({ ...ann, email: 'bob@mail.ru', nick: 'bob' });
    const { cookies } = await signUp();
    const res = await patchMe({ email: 'Bob@Mail.ru' }, cookies);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('email_taken');
  });
});

describe('POST /api/me/password', () => {
  it('wrong current → 400 wrong_password, nothing changes', async () => {
    const { id, cookies } = await signUp();
    await markVerified(id);
    const res = await post(
      '/api/me/password',
      { current: 'not my password', next: 'brand new password' },
      cookies,
    );
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('wrong_password');
    expect(
      (await post('/api/auth/login', { email: ann.email, password: ann.password })).statusCode,
    ).toBe(200);
  });

  it('changes the password and deletes every session except the current one', async () => {
    const { id, cookies } = await signUp();
    await markVerified(id);
    const other = sessionCookie(
      await post('/api/auth/login', { email: ann.email, password: ann.password }),
    );

    const res = await post(
      '/api/me/password',
      { current: ann.password, next: 'brand new password' },
      cookies,
    );
    expect(res.statusCode).toBe(204);
    expect((await getMe(cookies)).statusCode).toBe(200);
    expect((await getMe(other)).statusCode).toBe(401);
    expect(await h().db.select().from(sessions)).toHaveLength(1);

    expect(
      (await post('/api/auth/login', { email: ann.email, password: ann.password })).statusCode,
    ).toBe(401);
    expect(
      (await post('/api/auth/login', { email: ann.email, password: 'brand new password' }))
        .statusCode,
    ).toBe(200);
  });
});
