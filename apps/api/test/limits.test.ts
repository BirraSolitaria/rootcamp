// Rate limits with production values (R-M2-3): this file opts out of the harness's generous
// test defaults. Time comes from `deps.now`, so `clock.advance` moves every window.
import { hearts, streaks, users } from '@rootcamp/db';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { allOf, createLimiter } from '../src/services/limiter.js';
import { createSession } from '../src/services/sessions.js';
import { hashPassword } from '../src/services/users.js';
import { harnessAppDeps, TEST_PUBLIC_ORIGIN, useHarness } from './harness.js';

const h = useHarness({
  appFactory: (d) => buildApp({ ...harnessAppDeps(d), limits: undefined }),
});

const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };
const MINUTE_MS = 60_000;
const PASSWORD = 'correct horse battery';

type Res = Awaited<ReturnType<ReturnType<typeof h>['app']['inject']>>;

function errorOf(res: Res) {
  return (res.json() as { error: { code: string; message: string } }).error;
}

/** A 429 in the contract shape with a positive integer Retry-After (seconds). */
function expectRateLimited(res: Res) {
  expect(res.statusCode).toBe(429);
  expect(errorOf(res).code).toBe('rate_limited');
  expect(typeof errorOf(res).message).toBe('string');
  const retry = Number(res.headers['retry-after']);
  expect(Number.isInteger(retry) && retry > 0).toBe(true);
}

function post(url: string, payload: object, ip = '203.0.113.1', cookies?: Record<string, string>) {
  return h().app.inject({
    method: 'POST',
    url,
    headers: { ...csrf, 'x-forwarded-for': ip },
    payload,
    ...(cookies ? { cookies } : {}),
  });
}

const login = (email: string, password: string, ip?: string) =>
  post('/api/auth/login', { email, password }, ip);

function register(i: number, ip?: string) {
  return post(
    '/api/auth/register',
    { email: `u${i}@mail.ru`, nick: `user${i}`, password: PASSWORD, tz: 'Europe/Moscow' },
    ip,
  );
}

async function makeUser(email = 'ann@mail.ru') {
  const { db, clock } = h();
  const [u] = await db
    .insert(users)
    .values({
      email,
      nick: 'ann',
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(clock.now()),
    })
    .returning();
  const at = new Date(clock.now());
  await db.insert(hearts).values({ userId: u!.id, count: 5, lastRegenAt: at });
  await db.insert(streaks).values({ userId: u!.id, current: 0, best: 0 });
  const token = await createSession(db, u!.id, '10.0.0.1', 'vitest', clock.now());
  return { user: u!, cookies: { rc_sid: token } };
}

describe('login: 5/min per IP', () => {
  it('6th login within a minute from one IP → 429; another IP is unaffected; a minute later OK', async () => {
    const { clock } = h();
    for (let i = 0; i < 5; i++) {
      const res = await login(`x${i}@mail.ru`, 'wrong password');
      expect(res.statusCode).toBe(401);
    }
    expectRateLimited(await login('x9@mail.ru', 'wrong password'));
    expect((await login('x9@mail.ru', 'wrong password', '203.0.113.2')).statusCode).toBe(401);

    clock.advance(MINUTE_MS);
    expect((await login('x9@mail.ru', 'wrong password')).statusCode).toBe(401);
  });

  it('the IP limit applies before credentials: the right password is 429 too', async () => {
    await makeUser();
    for (let i = 0; i < 5; i++) await login('ann@mail.ru', 'wrong password');
    expectRateLimited(await login('ann@mail.ru', PASSWORD));
  });
});

describe('login: 20/h per email', () => {
  it('21st login for one email from different IPs → 429, case-insensitive, even with the right password', async () => {
    const { clock } = h();
    await makeUser();
    for (let i = 0; i < 20; i++) {
      const email = i % 2 ? 'ANN@mail.ru' : 'ann@mail.ru';
      const res = await login(email, 'wrong password', `198.51.100.${i + 1}`);
      expect(res.statusCode).toBe(401);
    }
    expectRateLimited(await login('Ann@Mail.RU', PASSWORD, '198.51.100.100'));

    // Another email from the same fresh IP still works.
    expect((await login('bob@mail.ru', 'wrong password', '198.51.100.101')).statusCode).toBe(401);

    clock.advance(61 * MINUTE_MS);
    expect((await login('ann@mail.ru', PASSWORD, '198.51.100.102')).statusCode).toBe(200);
  });

  it('an unknown email gets the same 429 as an existing one', async () => {
    await makeUser();
    const answers: Res[] = [];
    for (const email of ['ann@mail.ru', 'ghost@mail.ru']) {
      for (let i = 0; i < 20; i++) await login(email, 'wrong password', `192.0.2.${i + 1}`);
      answers.push(await login(email, 'wrong password', '192.0.2.200'));
    }
    for (const res of answers) expectRateLimited(res);
    expect(answers[0]!.json()).toEqual(answers[1]!.json());
  });
});

describe('register: 3/h per IP', () => {
  it('4th registration within an hour → 429; after 61 min → 201 again', async () => {
    const { clock } = h();
    for (let i = 0; i < 3; i++) expect((await register(i)).statusCode).toBe(201);
    expectRateLimited(await register(3));
    expect((await register(4, '203.0.113.9')).statusCode).toBe(201);

    clock.advance(61 * MINUTE_MS);
    expect((await register(5)).statusCode).toBe(201);
  });
});

describe('forgot: 3/h per IP', () => {
  it('4th request within an hour → 429; after 61 min → 204', async () => {
    const { clock } = h();
    for (let i = 0; i < 3; i++) {
      expect((await post('/api/auth/forgot', { email: `f${i}@mail.ru` })).statusCode).toBe(204);
    }
    expectRateLimited(await post('/api/auth/forgot', { email: 'f3@mail.ru' }));

    clock.advance(61 * MINUTE_MS);
    expect((await post('/api/auth/forgot', { email: 'f4@mail.ru' })).statusCode).toBe(204);
  });
});

describe('reset: 10/h per IP', () => {
  it('11th request within an hour → 429; another IP is unaffected; after 61 min → OK', async () => {
    const { clock } = h();
    const body = { token: 'A'.repeat(43), password: PASSWORD };
    for (let i = 0; i < 10; i++) {
      expect(errorOf(await post('/api/auth/reset', body)).code).toBe('token_invalid');
    }
    expectRateLimited(await post('/api/auth/reset', body));
    expect(errorOf(await post('/api/auth/reset', body, '203.0.113.9')).code).toBe('token_invalid');

    clock.advance(61 * MINUTE_MS);
    expect(errorOf(await post('/api/auth/reset', body)).code).toBe('token_invalid');
  });
});

describe('POST /api/me/password: 5/min and 20/h per user', () => {
  const change = (cookies: Record<string, string>, ip: string, current = 'wrong password') =>
    post('/api/me/password', { current, next: 'brand new password' }, ip, cookies);

  it('6th attempt within a minute → 429 even with the right password and from another IP', async () => {
    const { cookies } = await makeUser();
    for (let i = 0; i < 5; i++) {
      expect((await change(cookies, `192.0.2.${i + 1}`)).statusCode).toBe(400);
    }
    expectRateLimited(await change(cookies, '192.0.2.99', PASSWORD));
  });

  it('21st attempt within an hour → 429 although each minute stays under 5', async () => {
    const { clock } = h();
    const { cookies } = await makeUser();
    for (let i = 0; i < 20; i++) {
      if (i % 5 === 0 && i > 0) clock.advance(MINUTE_MS);
      expect((await change(cookies, '192.0.2.1')).statusCode).toBe(400);
    }
    clock.advance(MINUTE_MS);
    expectRateLimited(await change(cookies, '192.0.2.1', PASSWORD));
  });
});

describe('global: 300/min per user, else per IP', () => {
  it('301st request of a signed-in user within a minute → 429, even from a new IP', async () => {
    const { app, clock } = h();
    const { cookies } = await makeUser();
    const get = (ip: string) =>
      app.inject({ method: 'GET', url: '/api/me', cookies, headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 300; i++) {
      const res = await get(`10.1.${i >> 8}.${i & 255}`);
      expect(res.statusCode).toBe(200);
    }
    expectRateLimited(await get('10.9.9.9'));

    // Anonymous traffic from another IP is a separate budget.
    const anon = await post('/api/auth/logout', {}, '10.9.9.9');
    expect(anon.statusCode).toBe(204);

    clock.advance(MINUTE_MS);
    expect((await get('10.9.9.9')).statusCode).toBe(200);
  });

  it('anonymous requests count per IP', async () => {
    for (let i = 0; i < 300; i++) {
      expect((await post('/api/auth/logout', {}, '10.2.0.1')).statusCode).toBe(204);
    }
    expectRateLimited(await post('/api/auth/logout', {}, '10.2.0.1'));
    expect((await post('/api/auth/logout', {}, '10.2.0.2')).statusCode).toBe(204);
  });

  it('/api/health is not counted', async () => {
    const { app } = h();
    for (let i = 0; i < 301; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).not.toBe(429);
    }
  });
});

describe('TRUST_PROXY_HOPS', () => {
  it('0: X-Forwarded-For is ignored, so rotating it does not escape the per-IP login limit', async () => {
    const d = harnessAppDeps(h().deps);
    const app = await buildApp({
      ...d,
      config: { ...d.config, TRUST_PROXY_HOPS: 0 },
      limits: undefined,
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { ...csrf, 'x-forwarded-for': `198.18.0.${i + 1}` },
          payload: { email: `z${i}@mail.ru`, password: 'wrong password' },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    } finally {
      await app.close();
    }
  });
});

describe('limiter primitives', () => {
  it('retryAfterMs: time until the oldest counted hit leaves the window', () => {
    const l = createLimiter({ max: 2, windowMs: 1000 });
    expect(l.retryAfterMs('a', 0)).toBe(0);
    l.hit('a', 100);
    l.hit('a', 400);
    expect(l.retryAfterMs('a', 500)).toBe(600);
    expect(l.retryAfterMs('a', 1100)).toBe(0);
  });

  it('allOf records a hit in every limiter or in none', () => {
    const minute = createLimiter({ max: 5, windowMs: 60_000 });
    const hour = createLimiter({ max: 1, windowMs: 3600_000 });
    const both = allOf(minute, hour);
    expect(both.hit('a', 0)).toBe(true);
    expect(both.hit('a', 1)).toBe(false); // refused by `hour`…
    for (let i = 0; i < 4; i++) expect(minute.hit('a', 2)).toBe(true); // …`minute` kept 4 slots
    expect(both.retryAfterMs('a', 2)).toBe(3600_000 - 2);
  });
});
