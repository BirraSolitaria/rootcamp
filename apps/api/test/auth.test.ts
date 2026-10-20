import { createHash } from 'node:crypto';
import { UserDto } from '@rootcamp/api-contract';
import { emailLog, emailTokens, hearts, sessions, settings, streaks, users } from '@rootcamp/db';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLimiter } from '../src/services/limiter.js';
import { harnessAppDeps, TEST_PUBLIC_ORIGIN, useHarness, type MailpitMessage } from './harness.js';

const h = useHarness();

const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };
const DAY_MS = 24 * 3600_000;

const ann = {
  email: 'ann@mail.ru',
  nick: 'ann',
  password: 'correct horse battery',
  tz: 'Europe/Moscow',
};

function errorOf(res: { json(): unknown }) {
  return (res.json() as { error: { code: string; message: string } }).error;
}

function register(body: object) {
  return h().app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: csrf,
    payload: body,
  });
}

function verify(token: string) {
  return h().app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    headers: csrf,
    payload: { token },
  });
}

function resend(cookies: Record<string, string>) {
  return h().app.inject({
    method: 'POST',
    url: '/api/auth/resend-verification',
    headers: csrf,
    cookies,
  });
}

function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  const c = res.cookies.find((x) => x.name === 'rc_sid');
  if (!c) throw new Error('no rc_sid cookie');
  return { rc_sid: c.value };
}

function tokenFrom(msg: MailpitMessage): string {
  const m = /\/verify\?token=([A-Za-z0-9_-]+)/.exec(msg.text);
  if (!m) throw new Error(`no verify link in: ${msg.text}`);
  return m[1]!;
}

async function setSetting(key: string, value: unknown) {
  await h().db.update(settings).set({ value }).where(eq(settings.key, key));
}

describe('POST /api/auth/register', () => {
  it('201: user, session cookie, hearts/streaks rows, verify mail with a link', async () => {
    const res = await register(ann);
    expect(res.statusCode).toBe(201);
    const { user } = res.json() as { user: unknown };
    const dto = UserDto.parse(user);
    expect(dto).toMatchObject({
      email: 'ann@mail.ru',
      nick: 'ann',
      emailVerified: false,
      isAdmin: false,
      tz: 'Europe/Moscow',
      rank: 'guest',
      totalXp: 0,
      reminderEnabled: true,
      reminderTime: '20:00',
    });

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/rc_sid=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);

    const { db } = h();
    const [u] = await db.select().from(users);
    expect(u!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await db.select().from(hearts)).toMatchObject([{ userId: dto.id, count: 5 }]);
    expect(await db.select().from(streaks)).toMatchObject([
      { userId: dto.id, current: 0, best: 0, lastActivityDate: null },
    ]);
    expect(await db.select().from(sessions)).toHaveLength(1);

    const [msg] = await h().mail.waitForMessages('ann@mail.ru');
    expect(msg!.text).toContain(`${TEST_PUBLIC_ORIGIN}/verify?token=`);
    expect(msg!.html).toContain('/verify?token=');

    // Only a hash of the token is stored.
    const token = tokenFrom(msg!);
    const [t] = await db.select().from(emailTokens);
    expect(t).toMatchObject({ userId: dto.id, kind: 'verify' });
    expect(t!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(t!.tokenHash).not.toContain(token);
    expect(t!.expiresAt.getTime()).toBe(h().clock.now() + DAY_MS);

    const [log] = await db.select().from(emailLog);
    expect(log).toMatchObject({ userId: dto.id, kind: 'verify', status: 'sent', attempts: 1 });
  });

  it('the session cookie signs the new user in', async () => {
    const res = await register(ann);
    const me = await h().app.inject({
      method: 'POST',
      url: '/api/auth/resend-verification',
      headers: csrf,
      cookies: sessionCookie(res),
    });
    expect(me.statusCode).toBe(204);
  });

  it('email is case-insensitive: Ann@Mail.ru after ann@mail.ru → 409 email_taken', async () => {
    expect((await register(ann)).statusCode).toBe(201);
    const res = await register({ ...ann, email: 'Ann@Mail.ru', nick: 'ann2' });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('email_taken');
  });

  it('same nick → 409 nick_taken', async () => {
    expect((await register(ann)).statusCode).toBe(201);
    const res = await register({ ...ann, email: 'bob@mail.ru' });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('nick_taken');
  });

  it('honeypot website filled → 201, nothing created, no cookie, no mail', async () => {
    const res = await register({ ...ann, website: 'x' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toBeUndefined();
    const [{ n }] = (await h().db.select({ n: count() }).from(users)) as [{ n: number }];
    expect(n).toBe(0);
    expect(await h().db.select().from(emailLog)).toEqual([]);
  });

  it("registration_mode='closed' → 403 registration_closed", async () => {
    await setSetting('registration_mode', 'closed');
    const res = await register(ann);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('registration_closed');
  });

  it('max_users=1 with one user → 403 user_limit and registration closes', async () => {
    await setSetting('max_users', 1);
    expect((await register(ann)).statusCode).toBe(201);
    const res = await register({ ...ann, email: 'bob@mail.ru', nick: 'bob' });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('user_limit');
    const [mode] = await h()
      .db.select()
      .from(settings)
      .where(eq(settings.key, 'registration_mode'));
    expect(mode!.value).toBe('closed');
    const [{ n }] = (await h().db.select({ n: count() }).from(users)) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('invalid or empty tz → 400 validation', async () => {
    for (const tz of ['Mars/Base', '']) {
      const res = await register({ ...ann, tz });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation');
    }
  });

  it('bad nick / short password → 400 validation', async () => {
    for (const body of [
      { ...ann, nick: 'Ann' },
      { ...ann, password: 'short' },
    ]) {
      const res = await register(body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation');
    }
  });

  it('a failing mailer does not fail registration; email_log stays queued with the error', async () => {
    const { db } = h();
    const deps = harnessAppDeps(h().deps);
    const broken = await buildApp({
      ...deps,
      mailer: {
        async send() {
          throw new Error('smtp down');
        },
      },
    });
    try {
      const res = await broken.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: csrf,
        payload: ann,
      });
      expect(res.statusCode).toBe(201);
      const [log] = await db.select().from(emailLog);
      expect(log).toMatchObject({
        kind: 'verify',
        status: 'queued',
        attempts: 1,
        lastError: 'smtp down',
      });
    } finally {
      await broken.close();
    }
  });
});

describe('POST /api/auth/verify', () => {
  it('verifies the email; a second use → 409 token_used', async () => {
    await register(ann);
    const [msg] = await h().mail.waitForMessages('ann@mail.ru');
    const token = tokenFrom(msg!);

    const res = await verify(token);
    expect(res.statusCode).toBe(200);
    const { user } = res.json() as { user: unknown };
    expect(UserDto.parse(user).emailVerified).toBe(true);

    const again = await verify(token);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('token_used');
  });

  it('is public: works without a session', async () => {
    await register(ann);
    const [msg] = await h().mail.waitForMessages('ann@mail.ru');
    const res = await verify(tokenFrom(msg!));
    expect(res.statusCode).toBe(200);
  });

  it('after 24 h + 1 ms → token_expired', async () => {
    await register(ann);
    const [msg] = await h().mail.waitForMessages('ann@mail.ru');
    h().clock.advance(DAY_MS + 1);
    const res = await verify(tokenFrom(msg!));
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('token_expired');
  });

  it('still valid at exactly 24 h', async () => {
    await register(ann);
    const [msg] = await h().mail.waitForMessages('ann@mail.ru');
    h().clock.advance(DAY_MS);
    expect((await verify(tokenFrom(msg!))).statusCode).toBe(200);
  });

  it('unknown token → 400 token_invalid', async () => {
    const res = await verify('nope');
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('token_invalid');
  });
});

describe('POST /api/auth/resend-verification', () => {
  it('requires a session', async () => {
    const res = await resend({});
    expect(res.statusCode).toBe(401);
  });

  it('sends a new link and invalidates the previous one', async () => {
    const reg = await register(ann);
    const [first] = await h().mail.waitForMessages('ann@mail.ru');
    const res = await resend(sessionCookie(reg));
    expect(res.statusCode).toBe(204);
    const msgs = await h().mail.waitForMessages('ann@mail.ru', 2);
    const old = await verify(tokenFrom(first!));
    expect(errorOf(old).code).toBe('token_invalid');
    expect((await verify(tokenFrom(msgs[1]!))).statusCode).toBe(200);
  });

  it('two resends in a row → the second is 429 rate_limited', async () => {
    const reg = await register(ann);
    const cookies = sessionCookie(reg);
    expect((await resend(cookies)).statusCode).toBe(204);
    const res = await resend(cookies);
    expect(res.statusCode).toBe(429);
    expect(errorOf(res).code).toBe('rate_limited');
  });

  it('1/min and 5/day per user', async () => {
    const reg = await register(ann);
    const cookies = sessionCookie(reg);
    for (let i = 0; i < 5; i++) {
      expect((await resend(cookies)).statusCode).toBe(204);
      h().clock.advance(60_000);
    }
    expect((await resend(cookies)).statusCode).toBe(429);
    h().clock.advance(DAY_MS);
    expect((await resend(cookies)).statusCode).toBe(204);
  });

  it('already verified → 409 email_already_verified', async () => {
    const reg = await register(ann);
    const [msg] = await h().mail.waitForMessages('ann@mail.ru');
    expect((await verify(tokenFrom(msg!))).statusCode).toBe(200);
    const res = await resend(sessionCookie(reg));
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('email_already_verified');
  });
});

describe('createLimiter', () => {
  it('sliding window: max hits per window, rejected hits do not count', () => {
    const l = createLimiter({ max: 2, windowMs: 1000 });
    expect(l.hit('a', 0)).toBe(true);
    expect(l.hit('a', 500)).toBe(true);
    expect(l.hit('a', 999)).toBe(false);
    expect(l.hit('b', 999)).toBe(true);
    expect(l.hit('a', 1000)).toBe(true); // the hit at 0 left the window
    expect(l.hit('a', 1499)).toBe(false);
    expect(l.hit('a', 1500)).toBe(true);
  });
});
