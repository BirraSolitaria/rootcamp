import { createHash } from 'node:crypto';
import { sessions, users } from '@rootcamp/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { HttpError } from '../src/plugins/errors.js';
import { setSessionCookie } from '../src/plugins/session.js';
import {
  createSession,
  RENEW_AFTER_MS,
  revokeAllSessions,
  SESSION_TTL_MS,
} from '../src/services/sessions.js';
import { harnessAppDeps, TEST_PUBLIC_ORIGIN, useHarness } from './harness.js';

const h = useHarness({
  appFactory: async (d) => {
    const deps = harnessAppDeps(d);
    const app = await buildApp(deps);
    // Stub routes: `/api/progress` stands for any protected endpoint (M3 adds the real one).
    app.get('/api/progress', async (req) => ({ userId: req.user!.id }));
    if (!app.hasRoute({ method: 'PATCH', url: '/api/me' })) {
      app.patch('/api/me', async (req) => ({ userId: req.user!.id }));
    }
    app.post('/api/__echo', { config: { public: true } }, async () => ({ ok: true }));
    app.get('/api/__boom', { config: { public: true } }, async () => {
      throw new Error('kaboom: secret detail');
    });
    app.get('/api/__http-error', { config: { public: true } }, async () => {
      throw new HttpError(409, 'run_exists', 'run already active', { runId: 'r-1' });
    });
    app.post('/api/__zod', { config: { public: true } }, async (req) => {
      return z.object({ n: z.number() }).parse(req.body);
    });
    app.get('/api/__ip', { config: { public: true } }, async (req) => ({ ip: req.ip }));
    app.post('/api/__login', { config: { public: true } }, async (_req, reply) => {
      setSessionCookie(reply, 'tok', deps.config);
      return { ok: true };
    });
    return app;
  },
});

const csrf = { 'x-rc': '1', origin: TEST_PUBLIC_ORIGIN };

async function makeUser(opts: { verified?: boolean; status?: 'active' | 'banned' } = {}) {
  const { db, clock } = h();
  const [u] = await db
    .insert(users)
    .values({
      email: 'ann@mail.ru',
      nick: 'ann',
      passwordHash: 'x',
      emailVerifiedAt: opts.verified === false ? null : new Date(clock.now()),
      status: opts.status ?? 'active',
    })
    .returning();
  const token = await createSession(db, u!.id, '10.0.0.1', 'vitest', clock.now());
  return { user: u!, token, cookie: { rc_sid: token } };
}

function errorOf(res: { json(): unknown }) {
  return (res.json() as { error: { code: string; message: string; runId?: string } }).error;
}

describe('csrf', () => {
  it('rejects a mutating request without X-RC', async () => {
    const res = await h().app.inject({
      method: 'POST',
      url: '/api/__echo',
      headers: { origin: TEST_PUBLIC_ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('csrf');
  });

  it('rejects a foreign or missing Origin', async () => {
    for (const headers of [{ 'x-rc': '1', origin: 'https://evil.example' }, { 'x-rc': '1' }]) {
      const res = await h().app.inject({ method: 'POST', url: '/api/__echo', headers });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('csrf');
    }
  });

  it('rejects X-RC values other than 1', async () => {
    const res = await h().app.inject({
      method: 'POST',
      url: '/api/__echo',
      headers: { ...csrf, 'x-rc': 'yes' },
    });
    expect(errorOf(res).code).toBe('csrf');
  });

  it('accepts X-RC: 1 with the public origin; GET needs neither', async () => {
    const post = await h().app.inject({ method: 'POST', url: '/api/__echo', headers: csrf });
    expect(post.statusCode).toBe(200);
    const get = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(get.statusCode).toBe(200);
  });
});

describe('session', () => {
  it('protected route without a cookie → 401 unauthorized', async () => {
    const res = await h().app.inject({ method: 'GET', url: '/api/progress' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthorized');
  });

  it('unknown token → 401', async () => {
    const res = await h().app.inject({
      method: 'GET',
      url: '/api/progress',
      cookies: { rc_sid: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('valid session sets request.user', async () => {
    const { user, cookie } = await makeUser();
    const res = await h().app.inject({ method: 'GET', url: '/api/progress', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: user.id });
  });

  it('expired session → 401, row deleted, cookie cleared', async () => {
    const { cookie, token } = await makeUser();
    const { app, clock, db } = h();
    clock.advance(SESSION_TTL_MS + 1);
    const res = await app.inject({ method: 'GET', url: '/api/progress', cookies: cookie });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthorized');
    const id = createHash('sha256').update(token).digest('hex');
    expect(await db.select().from(sessions).where(eq(sessions.id, id))).toEqual([]);
    expect(String(res.headers['set-cookie'])).toMatch(/^rc_sid=;.*Max-Age=0/);
  });

  it('renews expires_at to now+30d only when more than 1 h passed since the last renewal', async () => {
    const { cookie } = await makeUser();
    const { app, clock, db } = h();
    const created = clock.now();

    clock.advance(RENEW_AFTER_MS); // exactly 1 h: no renewal yet
    let res = await app.inject({ method: 'GET', url: '/api/progress', cookies: cookie });
    expect(res.headers['set-cookie']).toBeUndefined();
    let [s] = await db.select().from(sessions);
    expect(s!.expiresAt.getTime()).toBe(created + SESSION_TTL_MS);

    clock.advance(1);
    res = await app.inject({ method: 'GET', url: '/api/progress', cookies: cookie });
    expect(res.statusCode).toBe(200);
    [s] = await db.select().from(sessions);
    expect(s!.expiresAt.getTime()).toBe(clock.now() + SESSION_TTL_MS);
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=2592000/);
  });

  it('banned user → 403 banned and all sessions deleted', async () => {
    const { cookie, user } = await makeUser({ status: 'banned' });
    const { app, db, clock } = h();
    await createSession(db, user.id, null, null, clock.now());
    const res = await app.inject({ method: 'GET', url: '/api/progress', cookies: cookie });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('banned');
    expect(await db.select().from(sessions)).toEqual([]);
  });

  it('createSession stores sha256(token); revokeAllSessions removes every session', async () => {
    const { db, clock } = h();
    const { user, token } = await makeUser();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [s] = await db.select().from(sessions);
    expect(s).toMatchObject({
      id: createHash('sha256').update(token).digest('hex'),
      userId: user.id,
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    expect(s!.expiresAt.getTime()).toBe(clock.now() + SESSION_TTL_MS);
    await createSession(db, user.id, null, null, clock.now());
    await revokeAllSessions(db, user.id);
    expect(await db.select().from(sessions)).toEqual([]);
  });

  it('session cookie is HttpOnly, Secure, SameSite=Lax, 30 days', async () => {
    const res = await h().app.inject({ method: 'POST', url: '/api/__login', headers: csrf });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^rc_sid=tok;/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});

describe('verified guard', () => {
  it('unverified user: GET /api/progress → 403 email_unverified', async () => {
    const { cookie } = await makeUser({ verified: false });
    const res = await h().app.inject({ method: 'GET', url: '/api/progress', cookies: cookie });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('email_unverified');
  });

  it('unverified user passes the guard on PATCH /api/me and /api/health', async () => {
    const { cookie, user } = await makeUser({ verified: false });
    const patch = await h().app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: csrf,
      cookies: cookie,
      payload: {},
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.stringify(patch.json())).toContain(user.id);
    const health = await h().app.inject({ method: 'GET', url: '/api/health', cookies: cookie });
    expect(health.statusCode).toBe(200);
  });
});

describe('errors', () => {
  it('unexpected Error → 500 internal with reqId in the message, no internals leaked', async () => {
    const res = await h().app.inject({ method: 'GET', url: '/api/__boom' });
    expect(res.statusCode).toBe(500);
    const err = errorOf(res);
    expect(err.code).toBe('internal');
    const reqId = res.headers['x-request-id'];
    expect(typeof reqId).toBe('string');
    expect(err.message).toContain(String(reqId));
    expect(err.message).not.toContain('kaboom');
  });

  it('HttpError → its status, code, message and extra fields', async () => {
    const res = await h().app.inject({ method: 'GET', url: '/api/__http-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'run_exists', message: 'run already active', runId: 'r-1' },
    });
  });

  it('ZodError → 400 validation', async () => {
    const res = await h().app.inject({
      method: 'POST',
      url: '/api/__zod',
      headers: csrf,
      payload: { n: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('validation');
  });

  it('malformed JSON body → 400 validation', async () => {
    const res = await h().app.inject({
      method: 'POST',
      url: '/api/__zod',
      headers: { ...csrf, 'content-type': 'application/json' },
      payload: '{',
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('validation');
  });

  it('req.ip trusts exactly one proxy hop (Caddy), ignoring client-supplied X-Forwarded-For', async () => {
    const res = await h().app.inject({
      method: 'GET',
      url: '/api/__ip',
      headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.7' },
    });
    expect(res.json()).toEqual({ ip: '10.0.0.7' });
  });

  it('unknown route → 404 not_found', async () => {
    const res = await h().app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
  });
});
