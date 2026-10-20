import { hearts, settings, users } from '@rootcamp/db/schema';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { useHarness } from './harness.js';

// An explicit factory, so this file does not depend on what the default app becomes (Task 3).
const h = useHarness({
  limits: { login: { max: 1000 } },
  appFactory: (deps) => {
    const app = Fastify();
    app.get('/__harness', async () => ({ now: deps.now(), limits: deps.limits }));
    return app;
  },
});

const baseUser = { email: 'ann@mail.ru', nick: 'ann', passwordHash: 'x' };

/** Postgres error code of a rejected query (drizzle wraps driver errors in `cause`). */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe('accounts schema constraints', () => {
  it('email and nick are case-insensitively unique (citext)', async () => {
    const { db } = h();
    await db.insert(users).values(baseUser);
    expect(
      await pgCode(db.insert(users).values({ ...baseUser, nick: 'ann2', email: 'Ann@Mail.RU' })),
    ).toBe('23505');
    expect(await pgCode(db.insert(users).values({ ...baseUser, email: 'b@mail.ru' }))).toBe(
      '23505',
    );
    // Stored nicks are lowercase (CHECK below); citext makes lookups case-insensitive.
    expect(await db.select({ id: users.id }).from(users).where(eq(users.nick, 'ANN'))).toHaveLength(
      1,
    );
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.email, 'ANN@mail.ru')),
    ).toHaveLength(1);
  });

  it('nick must match ^[a-z0-9_.]{3,20}$ (lowercase only)', async () => {
    const { db } = h();
    for (const nick of ['ab', 'Ann', 'a-b-c', 'a'.repeat(21)]) {
      expect(await pgCode(db.insert(users).values({ ...baseUser, nick })), nick).toBe('23514');
    }
    await db.insert(users).values({ ...baseUser, nick: 'a_b.c9' });
  });

  it('applies user defaults', async () => {
    const { db } = h();
    const [u] = await db.insert(users).values(baseUser).returning();
    expect(u).toMatchObject({
      isAdmin: false,
      status: 'active',
      rank: 'guest',
      totalXp: 0,
      reminderEnabled: true,
      reminderTime: '20:00:00',
      emailVerifiedAt: null,
    });
    expect(u!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('hearts.count is limited to 0..5', async () => {
    const { db } = h();
    const [u] = await db.insert(users).values(baseUser).returning();
    expect(await pgCode(db.insert(hearts).values({ userId: u!.id, count: 6 }))).toBe('23514');
    expect(await pgCode(db.insert(hearts).values({ userId: u!.id, count: -1 }))).toBe('23514');
    await db.insert(hearts).values({ userId: u!.id, count: 5 });
  });

  it('creates the xp_events indexes', async () => {
    const rows = await h().sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'xp_events'`;
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/\(user_id, day\)/);
    expect(defs).toMatch(/\(created_at\)/);
  });
});

describe('harness', () => {
  it('truncates between tests (1/2): writes data and changes settings', async () => {
    const { db } = h();
    await db.insert(users).values(baseUser);
    await db.update(settings).set({ value: 1 }).where(eq(settings.key, 'max_users'));
    await db.delete(settings).where(eq(settings.key, 'registration_mode'));
  });

  it('truncates between tests (2/2): tables are empty and default settings re-seeded', async () => {
    const { db } = h();
    expect(await db.select().from(users)).toEqual([]);
    const rows = await db.select().from(settings).orderBy(settings.key);
    expect(rows).toEqual([
      { key: 'max_users', value: 50 },
      { key: 'registration_mode', value: 'open' },
    ]);
  });

  it('clock is controllable and resets between tests', () => {
    const { clock } = h();
    clock.set(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(24 * 3600_000 + 1);
    expect(clock.now()).toBe(1_000 + 24 * 3600_000 + 1);
  });

  it('app factory receives the clock as deps.now and the injected opts', async () => {
    const { app, clock } = h();
    clock.set(42);
    const res = await app.inject({ method: 'GET', url: '/__harness' });
    expect(res.json()).toEqual({ now: 42, limits: { login: { max: 1000 } } });
  });

  it('mail.messages(to) returns Mailpit messages for that recipient', async () => {
    const { mail } = h();
    await mail.send({ to: 'ann@mail.ru', subject: 'Hello', text: 'verify?token=abc' });
    await mail.send({ to: 'bob@mail.ru', subject: 'Other', text: 'x' });
    const msgs = await mail.messages('ann@mail.ru');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ subject: 'Hello' });
    expect(msgs[0]!.text).toContain('verify?token=abc');
  });

  it('mailbox is cleared between tests', async () => {
    expect(await h().mail.messages('ann@mail.ru')).toEqual([]);
  });
});
