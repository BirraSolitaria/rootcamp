import { createHash } from 'node:crypto';
import { UserDto } from '@rootcamp/api-contract';
import { emailLog, emailTokens, hearts, sessions, settings, streaks, users } from '@rootcamp/db';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
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

  it('bad nick / password of 7 or 129 characters → 400 validation', async () => {
    for (const body of [
      { ...ann, nick: 'Ann' },
      { ...ann, password: '1234567' },
      { ...ann, password: 'a'.repeat(129) },
    ]) {
      const res = await register(body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('validation');
    }
  });

  it('passwords of 8 and 128 characters → 201', async () => {
    expect((await register({ ...ann, password: '12345678' })).statusCode).toBe(201);
    const bob = { ...ann, email: 'bob@mail.ru', nick: 'bob', password: 'a'.repeat(128) };
    expect((await register(bob)).statusCode).toBe(201);
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

const HOUR_MS = 3600_000;

function post(url: string, payload?: object, cookies: Record<string, string> = {}) {
  return h().app.inject({ method: 'POST', url, headers: csrf, payload, cookies });
}

function getMe(cookies: Record<string, string>) {
  return h().app.inject({ method: 'GET', url: '/api/me', cookies });
}

function login(email: string, password: string) {
  return post('/api/auth/login', { email, password });
}

function resetTokenFrom(msg: MailpitMessage): string {
  const m = /\/reset\?token=([A-Za-z0-9_-]+)/.exec(msg.text);
  if (!m) throw new Error(`no reset link in: ${msg.text}`);
  return m[1]!;
}

describe('POST /api/auth/login', () => {
  it('correct password → 200 {user}, a new working session cookie', async () => {
    await register(ann);
    const res = await login('Ann@Mail.ru', ann.password);
    expect(res.statusCode).toBe(200);
    const { user } = res.json() as { user: unknown };
    expect(UserDto.parse(user)).toMatchObject({ email: 'ann@mail.ru', nick: 'ann' });
    expect(String(res.headers['set-cookie'])).toMatch(/rc_sid=[A-Za-z0-9_-]{43};.*HttpOnly/);
    expect((await getMe(sessionCookie(res))).statusCode).toBe(200);
    expect(await h().db.select().from(sessions)).toHaveLength(2);
  });

  it('wrong password and unknown email → identical 401 invalid_credentials, no cookie', async () => {
    await register(ann);
    const wrong = await login(ann.email, 'wrong password!!');
    const unknown = await login('nobody@mail.ru', ann.password);
    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(errorOf(wrong).code).toBe('invalid_credentials');
    expect(wrong.body).toBe(unknown.body);
  });

  it('unknown email still runs argon2.verify (timing-safe)', async () => {
    const argon2 = (await import('argon2')).default;
    const spy = vi.spyOn(argon2, 'verify');
    try {
      const res = await login('nobody@mail.ru', ann.password);
      expect(res.statusCode).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatch(/^\$argon2id\$/);
    } finally {
      spy.mockRestore();
    }
  });

  it('banned user with the right password → 403 banned', async () => {
    await register(ann);
    await h().db.update(users).set({ status: 'banned' });
    const res = await login(ann.email, ann.password);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('banned');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('is public; bad body → 400 validation', async () => {
    const res = await post('/api/auth/login', { email: 'not-an-email', password: 'x' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('validation');
  });
});

describe('POST /api/auth/logout', () => {
  it('204, cookie cleared, the session no longer works', async () => {
    const cookies = sessionCookie(await register(ann));
    const res = await post('/api/auth/logout', undefined, cookies);
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === 'rc_sid');
    expect(cleared?.value).toBe('');
    expect(await h().db.select().from(sessions)).toHaveLength(0);
    const me = await getMe(cookies);
    expect(me.statusCode).toBe(401);
  });

  it('no cookie, or a stale one → still 204 and the cookie is cleared', async () => {
    const none = await post('/api/auth/logout');
    expect(none.statusCode).toBe(204);
    expect(none.cookies.find((c) => c.name === 'rc_sid')?.value).toBe('');

    const cookies = sessionCookie(await register(ann));
    expect((await post('/api/auth/logout', undefined, cookies)).statusCode).toBe(204);
    const stale = await post('/api/auth/logout', undefined, cookies);
    expect(stale.statusCode).toBe(204);
    expect(stale.cookies.find((c) => c.name === 'rc_sid')?.value).toBe('');
  });
});

describe('POST /api/auth/forgot + /api/auth/reset', () => {
  it('unknown email → 204, no letter, no email_log row', async () => {
    const res = await post('/api/auth/forgot', { email: 'nobody@mail.ru' });
    expect(res.statusCode).toBe(204);
    expect(await h().mail.messages('nobody@mail.ru')).toEqual([]);
    expect(await h().db.select().from(emailLog)).toEqual([]);
  });

  it('known email → 204, reset letter with a 1 h link', async () => {
    await register(ann);
    const res = await post('/api/auth/forgot', { email: 'ANN@mail.ru' });
    expect(res.statusCode).toBe(204);
    const msgs = await h().mail.waitForMessages('ann@mail.ru', 2);
    expect(msgs[1]!.text).toContain(`${TEST_PUBLIC_ORIGIN}/reset?token=`);
    const resets = await h().db.select().from(emailTokens).where(eq(emailTokens.kind, 'reset'));
    expect(resets).toHaveLength(1);
    expect(resets[0]!.expiresAt.getTime()).toBe(h().clock.now() + HOUR_MS);
    const logs = await h().db.select().from(emailLog).where(eq(emailLog.kind, 'reset'));
    expect(logs).toMatchObject([{ status: 'sent' }]);
  });

  it('reset → 204, every old session 401, new password works, old does not', async () => {
    const cookies = sessionCookie(await register(ann));
    await post('/api/auth/forgot', { email: ann.email });
    const msgs = await h().mail.waitForMessages('ann@mail.ru', 2);
    const token = resetTokenFrom(msgs[1]!);

    const res = await post('/api/auth/reset', { token, password: 'brand new password' });
    expect(res.statusCode).toBe(204);
    expect((await getMe(cookies)).statusCode).toBe(401);
    expect(await h().db.select().from(sessions)).toHaveLength(0);

    expect((await login(ann.email, ann.password)).statusCode).toBe(401);
    expect((await login(ann.email, 'brand new password')).statusCode).toBe(200);

    const again = await post('/api/auth/reset', { token, password: 'another password' });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('token_used');
  });

  it('reset link expires after 1 h; a verify token is not a reset token', async () => {
    await register(ann);
    const [verifyMsg] = await h().mail.waitForMessages('ann@mail.ru');
    const asReset = await post('/api/auth/reset', {
      token: tokenFrom(verifyMsg!),
      password: 'brand new password',
    });
    expect(errorOf(asReset).code).toBe('token_invalid');

    await post('/api/auth/forgot', { email: ann.email });
    const msgs = await h().mail.waitForMessages('ann@mail.ru', 2);
    h().clock.advance(HOUR_MS + 1);
    const res = await post('/api/auth/reset', {
      token: resetTokenFrom(msgs[1]!),
      password: 'brand new password',
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('token_expired');
  });

  it('invalid, used and expired tokens are refused before argon2 hashes the password', async () => {
    const argon2 = (await import('argon2')).default;
    await register(ann);
    await post('/api/auth/forgot', { email: ann.email });
    const used = resetTokenFrom((await h().mail.waitForMessages('ann@mail.ru', 2))[1]!);
    expect(
      (await post('/api/auth/reset', { token: used, password: 'brand new password' })).statusCode,
    ).toBe(204);
    await post('/api/auth/forgot', { email: ann.email });
    const expired = resetTokenFrom((await h().mail.waitForMessages('ann@mail.ru', 3))[2]!);
    h().clock.advance(HOUR_MS + 1);

    const spy = vi.spyOn(argon2, 'hash');
    try {
      const cases = [
        { token: 'A'.repeat(43), code: 'token_invalid', status: 400 },
        { token: used, code: 'token_used', status: 409 },
        { token: expired, code: 'token_expired', status: 400 },
      ];
      for (const c of cases) {
        const res = await post('/api/auth/reset', { token: c.token, password: 'another password' });
        expect(res.statusCode).toBe(c.status);
        expect(errorOf(res).code).toBe(c.code);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a valid token is consumed once even when two resets race', async () => {
    await register(ann);
    await post('/api/auth/forgot', { email: ann.email });
    const token = resetTokenFrom((await h().mail.waitForMessages('ann@mail.ru', 2))[1]!);
    const [a, b] = await Promise.all([
      post('/api/auth/reset', { token, password: 'first new password' }),
      post('/api/auth/reset', { token, password: 'second new password' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([204, 409]);
  });

  it('7-character new password → 400 validation', async () => {
    const res = await post('/api/auth/reset', { token: 'x', password: '1234567' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('validation');
  });
});
