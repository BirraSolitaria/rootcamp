// Lifecycle + internal REST against real PostgreSQL 16 (Testcontainers) and a real dockerd
// (runc-dev driver, image rc/test-shell). Runs where Docker is reachable (the VPS, R-M4a-1).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { SandboxView } from '@rootcamp/api-contract';
import {
  createDb,
  runMigrations,
  sandboxUsage,
  sandboxes,
  settings,
  users,
  type DbHandle,
} from '@rootcamp/db';
import Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { RuncDevDriver } from '../src/driver/runc-dev.js';
import { CLASS_LIMITS, SANDBOX_LABEL } from '../src/driver/types.js';
import { Lifecycle } from '../src/lifecycle.js';

const docker = new Docker();
const dockerAvailable = await docker.ping().then(
  () => true,
  () => false,
);

const MIGRATIONS_DIR = fileURLToPath(new URL('../../api/drizzle', import.meta.url));
const TOKEN = 'test-internal-token-0123456789';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const MIN = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.runIf(dockerAvailable)('lifecycle and internal API (runc-dev, real Postgres)', () => {
  let pg: StartedPostgreSqlContainer;
  let h: DbHandle;
  let app: FastifyInstance;
  let lifecycle: Lifecycle;
  const driver = new RuncDevDriver({ docker, network: 'rc-sbx-dev' });

  async function newUser(): Promise<string> {
    const nick = `u${randomUUID().slice(0, 8)}`;
    const [u] = await h.db
      .insert(users)
      .values({ email: `${nick}@rootcamp.test`, nick, passwordHash: 'x', tz: 'Europe/Moscow' })
      .returning({ id: users.id });
    return u!.id;
  }

  const body = (over: Record<string, unknown> = {}) => ({
    runId: randomUUID(),
    userId: null,
    image: 'rc/linux-base:24.04',
    class: 'light',
    hostname: 'web-01',
    title: 'Nginx упал',
    setupScript: 'echo setup-ran > /root/marker',
    setupTimeoutSec: 30,
    ttlMin: 30,
    ...over,
  });

  async function create(over: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/internal/sandboxes',
      headers: AUTH,
      payload: body(over),
    });
  }

  async function get(id: string): Promise<SandboxView> {
    const r = await app.inject({ method: 'GET', url: `/internal/sandboxes/${id}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    return r.json() as SandboxView;
  }

  async function waitState(id: string, states: string[], timeoutMs = 10_000): Promise<SandboxView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await get(id);
      if (states.includes(v.state)) return v;
      if (Date.now() > deadline)
        throw new Error(`sandbox ${id} still ${v.state} after ${timeoutMs} ms`);
      await sleep(200);
    }
  }

  async function row(id: string) {
    const [r] = await h.db.select().from(sandboxes).where(eq(sandboxes.id, id));
    return r!;
  }

  async function containersOf(id: string) {
    return docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=${id}`] } });
  }

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16')
      .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off'])
      .start();
    const host = pg.getHost() === 'localhost' ? '127.0.0.1' : pg.getHost();
    const url = `postgres://${pg.getUsername()}:${pg.getPassword()}@${host}:${pg.getPort()}/${pg.getDatabase()}`;
    h = createDb(url);
    await runMigrations(h.db, MIGRATIONS_DIR);
    const config = loadConfig({
      DATABASE_URL: url,
      INTERNAL_TOKEN: TOKEN,
      TICKET_SECRET: 'test-ticket-secret-0123456789abcdef',
      SANDBOX_DRIVER: 'runc-dev',
      NODE_ENV: 'test',
    });
    await driver.ensureNetwork();
    lifecycle = new Lifecycle({
      db: h.db,
      driver,
      budget: config.budget,
      queueMax: config.queueMax,
      diskFreeGb: async () => 100,
    });
    app = await buildApp({ config, driver, db: h.db, lifecycle });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    if (h) {
      // Every container this suite created carries the label of a row in this database.
      const ids = new Set(
        (await h.db.select({ id: sandboxes.id }).from(sandboxes)).map((r) => r.id),
      );
      const list = await docker.listContainers({ all: true, filters: { label: [SANDBOX_LABEL] } });
      for (const c of list) {
        if (!ids.has(c.Labels[SANDBOX_LABEL] ?? '')) continue;
        await docker
          .getContainer(c.Id)
          .remove({ force: true, v: true })
          .catch(() => {});
      }
      await h.close();
    }
    await pg?.stop();
  }, 120_000);

  test('every internal route needs the bearer token', async () => {
    const none = await app.inject({ method: 'POST', url: '/internal/sandboxes', payload: body() });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const wrong = await app.inject({
      method: 'GET',
      url: `/internal/sandboxes/${randomUUID()}`,
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  test('a request is validated', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/internal/sandboxes',
      headers: AUTH,
      payload: { ...body(), class: 'huge' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: { code: 'validation' } });
  });

  describe('a user sandbox', () => {
    let userId = '';
    let id = '';

    test('is queued, then ready within 10 s with title and setup applied', async () => {
      userId = await newUser();
      const started = Date.now();
      const r = await create({ userId });
      expect(r.statusCode).toBe(201);
      const v = r.json() as SandboxView;
      expect(v.state).toBe('queued');
      expect(v.queuePosition).toBe(1);
      id = v.sandboxId;

      const ready = await waitState(id, ['ready', 'failed']);
      expect(ready.state).toBe('ready');
      expect(Date.now() - started).toBeLessThanOrEqual(10_000);
      expect(ready.queuePosition).toBeNull();
      const readyAt = Date.parse(ready.readyAt!);
      expect(Date.parse(ready.expiresAt!)).toBe(readyAt + 30 * MIN);
      expect(Date.parse(ready.hardDeadline!)).toBe(readyAt + 90 * MIN);
      expect(ready.canExtend).toBe(false);

      const r0 = await row(id);
      const out = await driver.exec(
        r0.containerId!,
        'cat /etc/rootcamp/title; echo; cat /root/marker',
        {
          timeoutSec: 5,
        },
      );
      expect(out.output).toBe('Nginx упал\nsetup-ran\n');
      expect(r0.lastActivityAt).not.toBeNull();
    });

    test('a second POST for the same user while it is active → 409 run_exists', async () => {
      const r = await create({ userId });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: { code: 'run_exists' } });
    });

    test('exec-checks: sequential, stdout only, ≤ 300 chars of binary noise, timeout message', async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/internal/sandboxes/${id}/exec-checks`,
        headers: AUTH,
        payload: {
          checks: [
            { goalId: 'noise', script: 'head -c 1000000 /dev/urandom', timeoutSec: 20 },
            { goalId: 'streams', script: 'echo out; echo err >&2; exit 3', timeoutSec: 5 },
            { goalId: 'slow', script: 'sleep 5', timeoutSec: 1 },
          ],
        },
      });
      expect(r.statusCode).toBe(200);
      const [noise, streams, slow] = r.json() as {
        goalId: string;
        exitCode: number;
        output: string;
        timedOut: boolean;
      }[];
      expect(noise!.goalId).toBe('noise');
      expect(noise!.exitCode).toBe(0);
      expect(noise!.output.length).toBeLessThanOrEqual(300);
      expect(noise!.output.length).toBeGreaterThan(0);
      expect(streams).toEqual({ goalId: 'streams', exitCode: 3, output: 'out\n', timedOut: false });
      expect(slow).toEqual({
        goalId: 'slow',
        exitCode: 124,
        output: 'проверка не уложилась в 1 с',
        timedOut: true,
      });
    });

    test('extend: 409 with 20 min left, +15 min with 5 min left, capped by hard_deadline', async () => {
      const set = (expiresAt: Date) =>
        h.db.update(sandboxes).set({ expiresAt }).where(eq(sandboxes.id, id));
      const extend = () =>
        app.inject({ method: 'POST', url: `/internal/sandboxes/${id}/extend`, headers: AUTH });

      await set(new Date(Date.now() + 20 * MIN));
      const early = await extend();
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({ error: { code: 'extend_not_allowed' } });

      const soon = new Date(Date.now() + 5 * MIN);
      await set(soon);
      expect((await get(id)).canExtend).toBe(true);
      const ok = await extend();
      expect(ok.statusCode).toBe(200);
      expect(Date.parse((ok.json() as { expiresAt: string }).expiresAt)).toBe(
        soon.getTime() + 15 * MIN,
      );

      // Near the hard deadline: +15 min is capped to it, and then nothing is left to extend.
      const hardDeadline = new Date(Date.now() + 8 * MIN);
      await h.db
        .update(sandboxes)
        .set({ expiresAt: new Date(Date.now() + 5 * MIN), hardDeadline })
        .where(eq(sandboxes.id, id));
      const capped = await extend();
      expect(capped.statusCode).toBe(200);
      expect(Date.parse((capped.json() as { expiresAt: string }).expiresAt)).toBe(
        hardDeadline.getTime(),
      );
      expect((await get(id)).canExtend).toBe(false);
      const atDeadline = await extend();
      expect(atDeadline.statusCode).toBe(409);
      expect(atDeadline.json()).toMatchObject({ error: { code: 'extend_not_allowed' } });
    });

    test('DELETE removes the container, emits closed and books the minutes', async () => {
      const closed: [string, string][] = [];
      const off = lifecycle.onSandboxClosed((sid, reason) => closed.push([sid, reason]));
      // Pretend it ran for a while: ready 90 s ago → 2 minutes.
      await h.db
        .update(sandboxes)
        .set({ readyAt: new Date(Date.now() - 90_000) })
        .where(eq(sandboxes.id, id));
      const r = await app.inject({
        method: 'DELETE',
        url: `/internal/sandboxes/${id}`,
        headers: AUTH,
        payload: { reason: 'stopped_by_user' },
      });
      off();
      expect(r.statusCode).toBe(204);
      expect(await containersOf(id)).toEqual([]);
      const v = await get(id);
      expect(v).toMatchObject({
        state: 'stopped',
        stopReason: 'stopped_by_user',
        canExtend: false,
      });
      expect(closed).toEqual([[id, 'stopped_by_user']]);
      const usage = await h.db.select().from(sandboxUsage).where(eq(sandboxUsage.userId, userId));
      expect(usage).toHaveLength(1);
      expect(usage[0]!.minutes).toBeGreaterThanOrEqual(1);
      expect(usage[0]!.minutes).toBe(2);

      // Idempotent; the freed user can start again.
      const again = await app.inject({
        method: 'DELETE',
        url: `/internal/sandboxes/${id}`,
        headers: AUTH,
        payload: { reason: 'stopped_by_user' },
      });
      expect(again.statusCode).toBe(204);
      const next = await create({ userId });
      expect(next.statusCode).toBe(201);
      const nid = (next.json() as SandboxView).sandboxId;
      await app.inject({
        method: 'DELETE',
        url: `/internal/sandboxes/${nid}`,
        headers: AUTH,
        payload: { reason: 'stopped_by_user' },
      });
      expect((await get(nid)).state).toBe('stopped');
    });
  });

  test('a failing setup → failed/setup_failed with its stderr in failure_output', async () => {
    const userId = await newUser();
    const r = await create({ userId, setupScript: 'echo preparing; echo boom >&2; exit 1' });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as SandboxView).sandboxId;
    const v = await waitState(id, ['failed', 'ready']);
    expect(v).toMatchObject({ state: 'failed', stopReason: 'setup_failed' });
    const r0 = await row(id);
    expect(r0.failureOutput).toContain('preparing');
    expect(r0.failureOutput).toContain('boom');
    expect(await containersOf(id)).toEqual([]);
    const usage = await h.db.select().from(sandboxUsage).where(eq(sandboxUsage.userId, userId));
    expect(usage).toEqual([]);
  });

  test('DELETE during a running setup aborts the start and removes the container', async () => {
    const userId = await newUser();
    const r = await create({ userId, setupScript: 'sleep 60', setupTimeoutSec: 90 });
    const id = (r.json() as SandboxView).sandboxId;
    const deadline = Date.now() + 10_000;
    while (!(await row(id)).containerId) {
      if (Date.now() > deadline) throw new Error('no container yet');
      await sleep(100);
    }
    expect((await row(id)).state).toBe('starting');
    const started = Date.now();
    const del = await app.inject({
      method: 'DELETE',
      url: `/internal/sandboxes/${id}`,
      headers: AUTH,
      payload: { reason: 'reset' },
    });
    expect(del.statusCode).toBe(204);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await get(id)).toMatchObject({ state: 'stopped', stopReason: 'reset', readyAt: null });
    expect(await containersOf(id)).toEqual([]);
    expect(await h.db.select().from(sandboxUsage).where(eq(sandboxUsage.userId, userId))).toEqual(
      [],
    );
  });

  test('a stale container with the same name is replaced on start', async () => {
    const id = randomUUID();
    const userId = await newUser();
    const stale = await driver.createContainer({
      sandboxId: id,
      userId,
      image: 'rc/test-shell',
      class: 'light',
      hostname: 'stale',
      limits: CLASS_LIMITS.light,
    });
    await h.db.insert(sandboxes).values({
      id,
      runId: randomUUID(),
      userId,
      image: 'rc/linux-base:24.04',
      class: 'light',
      cpu: 0.5,
      memMb: 512,
      hostname: 'web-01',
      setupScript: 'true',
      setupTimeoutSec: 10,
      ttlMin: 10,
    });
    lifecycle.wake();
    const v = await waitState(id, ['ready', 'failed']);
    expect(v.state).toBe('ready');
    const list = await containersOf(id);
    expect(list).toHaveLength(1);
    expect(list[0]!.Id).not.toBe(stale);
    await lifecycle.stopSandbox(id, 'stopped_by_admin');
    expect(await containersOf(id)).toEqual([]);
  });

  test('a queued request older than 20 min → stopped/queue_timeout', async () => {
    const userId = await newUser();
    const [r] = await h.db
      .insert(sandboxes)
      .values({
        runId: randomUUID(),
        userId,
        image: 'rc/linux-base:24.04',
        class: 'light',
        cpu: 0.5,
        memMb: 512,
        hostname: 'web-01',
        setupScript: 'true',
        setupTimeoutSec: 10,
        ttlMin: 10,
        queuedAt: new Date(Date.now() - 21 * MIN),
      })
      .returning({ id: sandboxes.id });
    lifecycle.wake();
    const v = await waitState(r!.id, ['stopped', 'ready', 'starting']);
    expect(v).toMatchObject({ state: 'stopped', stopReason: 'queue_timeout' });
  });

  test('drained: user requests → 409 queue_full, a test sandbox still starts', async () => {
    await h.db
      .insert(settings)
      .values({ key: 'sandboxes_drained', value: true })
      .onConflictDoUpdate({ target: settings.key, set: { value: true } });
    try {
      const userId = await newUser();
      const denied = await create({ userId });
      expect(denied.statusCode).toBe(409);
      expect(denied.json()).toMatchObject({ error: { code: 'queue_full' } });

      const booked = (await h.db.select().from(sandboxUsage)).length;
      const r = await create({ userId: null, test: true });
      expect(r.statusCode).toBe(201);
      const v = r.json() as SandboxView;
      expect(v.queuePosition).toBeNull();
      const ready = await waitState(v.sandboxId, ['ready', 'failed']);
      expect(ready.state).toBe('ready');
      const del = await app.inject({
        method: 'DELETE',
        url: `/internal/sandboxes/${v.sandboxId}`,
        headers: AUTH,
        payload: { reason: 'stopped_by_admin' },
      });
      expect(del.statusCode).toBe(204);
      expect(await containersOf(v.sandboxId)).toEqual([]);
      // No user: nothing is booked.
      expect(await h.db.select().from(sandboxUsage)).toHaveLength(booked);
    } finally {
      await h.db
        .update(settings)
        .set({ value: false })
        .where(eq(settings.key, 'sandboxes_drained'));
    }
  });

  test('unknown sandbox → 404', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/internal/sandboxes/${randomUUID()}`,
      headers: AUTH,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
