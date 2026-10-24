import { randomUUID } from 'node:crypto';
import type { SandboxState, WsCloseReason } from '@rootcamp/api-contract';
import { sandboxUsage, sandboxes, type DbHandle } from '@rootcamp/db';
import type Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DockerDriver, IMAGE_PRUNE_FILTERS, parseDockerEvent } from '../src/driver/docker.js';
import { CLASS_LIMITS, type ContainerEvent, type ManagedContainer } from '../src/driver/types.js';
import { watchEvents } from '../src/events.js';
import {
  DISK_QUOTA_MB,
  Gc,
  IDLE_MS,
  STARTING_TIMEOUT_MS,
  dailyPrune,
  gcPlan,
  nextPruneAt,
  type GcRow,
} from '../src/gc.js';
import { Lifecycle } from '../src/lifecycle.js';
import {
  ScopedDriver,
  allRowIds,
  containersOf,
  createBody,
  docker,
  dockerAvailable,
  newUser,
  startPg,
  sweep,
  waitFor,
  type Pg,
} from './helpers/stack.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function ready(n: number, over: Partial<GcRow> = {}): GcRow {
  return {
    id: id(n),
    state: 'ready',
    containerId: `c${n}`,
    readyAt: new Date(NOW - 5 * MIN),
    expiresAt: new Date(NOW + 20 * MIN),
    lastActivityAt: new Date(NOW - MIN),
    ...over,
  };
}
const running = (n: number, isRunning = true): ManagedContainer => ({
  containerId: `c${n}`,
  sandboxId: id(n),
  running: isRunning,
});

function plan(
  active: GcRow[],
  o: {
    containers?: ManagedContainer[];
    states?: [string, SandboxState][];
    conns?: Record<string, number>;
    disk?: [string, number][];
    since?: Record<string, number>;
  } = {},
) {
  return gcPlan({
    now: NOW,
    active,
    containers:
      o.containers ??
      active
        .filter((r) => r.containerId)
        .map((r) => ({
          containerId: r.containerId!,
          sandboxId: r.id,
          running: true,
        })),
    containerRowStates: new Map(
      o.states ?? active.map((r): [string, SandboxState] => [r.id, r.state]),
    ),
    connectionCount: (sid) => o.conns?.[sid] ?? 0,
    diskMb: new Map(o.disk ?? []),
    startingSince: (sid) => o.since?.[sid],
  });
}

describe('gcPlan (pure)', () => {
  test('expires_at in the past → stop/expired, even with a terminal open', () => {
    const p = plan([ready(1, { expiresAt: new Date(NOW - 1) })], { conns: { [id(1)]: 2 } });
    expect(p.stop).toEqual([{ id: id(1), reason: 'expired' }]);
    expect(p.dead).toEqual([]);
    expect(p.orphans).toEqual([]);
  });

  test('idle needs both 0 connections and last activity older than 10 min', () => {
    const old = new Date(NOW - IDLE_MS - 1);
    expect(plan([ready(1, { lastActivityAt: old })]).stop).toEqual([{ id: id(1), reason: 'idle' }]);
    expect(plan([ready(1, { lastActivityAt: old })], { conns: { [id(1)]: 1 } }).stop).toEqual([]);
    expect(plan([ready(1, { lastActivityAt: new Date(NOW - IDLE_MS + 1000) })]).stop).toEqual([]);
    // No activity recorded: counted from ready_at.
    expect(
      plan([ready(1, { lastActivityAt: null, readyAt: new Date(NOW - 11 * MIN) })]).stop,
    ).toEqual([{ id: id(1), reason: 'idle' }]);
  });

  test('disk over 3072 MiB → disk_quota; expiry wins over disk', () => {
    expect(DISK_QUOTA_MB).toBe(3072);
    expect(plan([ready(1)], { disk: [[id(1), 3073]] }).stop).toEqual([
      { id: id(1), reason: 'disk_quota' },
    ]);
    expect(plan([ready(1)], { disk: [[id(1), 3072]] }).stop).toEqual([]);
    expect(
      plan([ready(1, { expiresAt: new Date(NOW - 1) })], { disk: [[id(1), 9999]] }).stop,
    ).toEqual([{ id: id(1), reason: 'expired' }]);
  });

  test('starting for more than 5 min → fail; unknown start time → left alone', () => {
    const s = (n: number): GcRow => ({ ...ready(n), state: 'starting', readyAt: null });
    const p = plan([s(1), s(2), s(3)], {
      since: { [id(1)]: NOW - STARTING_TIMEOUT_MS - 1, [id(2)]: NOW - 4 * MIN },
    });
    expect(p.failStarting).toEqual([id(1)]);
    expect(p.stop).toEqual([]);
  });

  test('a ready row whose container is gone → lost; stopped container → crashed', () => {
    const p = plan([ready(1), ready(2), ready(3, { containerId: null })], {
      containers: [running(2, false)],
    });
    expect(p.dead).toEqual([
      { id: id(1), containerId: 'c1', reason: 'lost' },
      { id: id(2), containerId: 'c2', reason: 'crashed' },
      { id: id(3), containerId: null, reason: 'lost' },
    ]);
    expect(p.stop).toEqual([]);
    expect(p.orphans).toEqual([]);
  });

  test('orphans: labelled containers with no row or a stopped/failed row', () => {
    const containers: ManagedContainer[] = [
      { containerId: 'none', sandboxId: id(10), running: true },
      { containerId: 'bad-label', sandboxId: 'not-a-uuid', running: true },
      { containerId: 'stopped', sandboxId: id(11), running: false },
      { containerId: 'failed', sandboxId: id(12), running: true },
      { containerId: 'stopping', sandboxId: id(13), running: true },
      { containerId: 'queued', sandboxId: id(14), running: true },
      { containerId: 'starting', sandboxId: id(15), running: true },
    ];
    const p = plan([], {
      containers,
      states: [
        [id(11), 'stopped'],
        [id(12), 'failed'],
        [id(13), 'stopping'],
        [id(14), 'queued'],
        [id(15), 'starting'],
      ],
    });
    expect(p.orphans).toEqual(['none', 'bad-label', 'stopped', 'failed']);
  });
});

describe('daily prune', () => {
  test('next run is 04:00 MSK (01:00 UTC), strictly after now', () => {
    expect(new Date(nextPruneAt(Date.parse('2026-10-24T00:30:00Z'))).toISOString()).toBe(
      '2026-10-24T01:00:00.000Z',
    );
    expect(new Date(nextPruneAt(Date.parse('2026-10-24T01:00:00Z'))).toISOString()).toBe(
      '2026-10-25T01:00:00.000Z',
    );
    expect(new Date(nextPruneAt(Date.parse('2026-10-24T22:00:00Z'))).toISOString()).toBe(
      '2026-10-25T01:00:00.000Z',
    );
  });

  test('dailyPrune runs both prunes; a failing image prune does not skip volumes', async () => {
    const calls: string[] = [];
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await dailyPrune(
      {
        pruneImages: async () => {
          calls.push('images');
          throw new Error('boom');
        },
        pruneVolumes: async () => {
          calls.push('volumes');
        },
      },
      log,
    );
    expect(calls).toEqual(['images', 'volumes']);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  // Never against the shared daemon: a fake dockerode checks what would be sent.
  test('image prune: dangling only, never images labelled rootcamp.keep', async () => {
    const fake = {
      pruneImages: vi.fn(async () => ({})),
      pruneVolumes: vi.fn(async () => ({})),
      version: vi.fn(async () => ({ ApiVersion: '1.47' })),
    };
    const d = new DockerDriver({ docker: fake as unknown as Docker, network: 'x' });
    await d.pruneImages();
    expect(IMAGE_PRUNE_FILTERS).toEqual({ dangling: ['true'], 'label!': ['rootcamp.keep'] });
    expect(fake.pruneImages).toHaveBeenCalledWith({ filters: IMAGE_PRUNE_FILTERS });
    await d.pruneVolumes();
    // No `all` filter: since API 1.42 that prunes anonymous volumes only, like the CLI.
    expect(fake.pruneVolumes).toHaveBeenCalledWith({});
  });

  test('volume prune refuses daemons older than API 1.42 (they would drop named volumes)', async () => {
    const fake = {
      pruneVolumes: vi.fn(async () => ({})),
      version: vi.fn(async () => ({ ApiVersion: '1.41' })),
    };
    const d = new DockerDriver({ docker: fake as unknown as Docker, network: 'x' });
    await expect(d.pruneVolumes()).rejects.toThrow(/1\.42/);
    expect(fake.pruneVolumes).not.toHaveBeenCalled();
  });
});

describe('docker events', () => {
  test('parseDockerEvent keeps die/oom of labelled containers', () => {
    const die = {
      Type: 'container',
      Action: 'die',
      Actor: { ID: 'abc', Attributes: { 'rootcamp.sandbox': id(1), exitCode: '137' } },
      time: 1_700_000_000,
      timeNano: 1_700_000_000_123_000_000,
    };
    expect(parseDockerEvent(die)).toEqual({
      action: 'die',
      containerId: 'abc',
      sandboxId: id(1),
      exitCode: 137,
      timeMs: 1_700_000_000_123,
    });
    expect(parseDockerEvent({ ...die, Action: 'oom' })).toMatchObject({
      action: 'oom',
      exitCode: 137,
    });
    expect(parseDockerEvent({ ...die, Action: 'start' })).toBeNull();
    expect(parseDockerEvent({ ...die, Actor: { ID: 'abc', Attributes: {} } })).toBeNull();
    expect(parseDockerEvent({ ...die, Type: 'network' })).toBeNull();
  });

  function fakeWatch() {
    const subs: {
      sinceMs?: number;
      onEvent: (e: ContainerEvent) => void;
      onEnd: (err?: unknown) => void;
    }[] = [];
    const failed: unknown[][] = [];
    let oomKilled = false;
    const w = watchEvents({
      driver: {
        watchEvents: async (o) => {
          subs.push(o);
          return () => {};
        },
        containerState: async () => ({ running: false, oomKilled, exitCode: 137 }),
      },
      lifecycle: {
        failSandbox: async (...args: unknown[]) => {
          failed.push(args);
          return true;
        },
      },
      retryMs: 10,
      now: () => NOW,
    });
    return { w, subs, failed, setOom: (v: boolean) => (oomKilled = v) };
  }
  const ev = (action: 'die' | 'oom', over: Partial<ContainerEvent> = {}): ContainerEvent => ({
    action,
    containerId: 'c1',
    sandboxId: id(1),
    exitCode: 137,
    timeMs: NOW,
    ...over,
  });

  test('die → failed/crashed; an oom before it (or OOMKilled) → failed/oom', async () => {
    const f = fakeWatch();
    await f.w.ready;
    f.subs[0]!.onEvent(ev('die'));
    f.subs[0]!.onEvent(ev('oom', { containerId: 'c2', sandboxId: id(2) }));
    f.subs[0]!.onEvent(ev('die', { containerId: 'c2', sandboxId: id(2) }));
    f.subs[0]!.onEvent(ev('die', { sandboxId: 'nope' }));
    await f.w.idle();
    f.setOom(true);
    f.subs[0]!.onEvent(ev('die', { containerId: 'c3', sandboxId: id(3) }));
    await f.w.idle();
    expect(f.failed.map((a) => [a[0], a[1], a[3]])).toEqual([
      [id(1), 'crashed', { from: ['ready'], containerId: 'c1' }],
      [id(2), 'oom', { from: ['ready'], containerId: 'c2' }],
      [id(3), 'oom', { from: ['ready'], containerId: 'c3' }],
    ]);
    expect(f.failed[0]![2]).toMatch(/137/);
    f.w.stop();
  });

  test('a broken event stream reconnects from the last event time', async () => {
    const f = fakeWatch();
    await f.w.ready;
    f.subs[0]!.onEvent(ev('die', { timeMs: NOW + 5000 }));
    f.subs[0]!.onEnd(new Error('dockerd restarted'));
    await waitFor('reconnect', async () => f.subs.length === 2, 1000);
    expect(f.subs[1]!.sinceMs).toBe(NOW + 5000);
    f.w.stop();
    f.subs[1]!.onEnd();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.subs).toHaveLength(2);
  });
});

describe.runIf(dockerAvailable)('GC and docker events (runc-dev, real Postgres)', () => {
  let pg: Pg;
  let h: DbHandle;
  let driver: ScopedDriver;
  let lifecycle: Lifecycle;
  let gc: Gc;
  let events: ReturnType<typeof watchEvents>;
  let conns = 0;
  const closed: [string, WsCloseReason][] = [];

  const row = async (sid: string) =>
    (await h.db.select().from(sandboxes).where(eq(sandboxes.id, sid)))[0]!;

  async function readySandbox(over: Record<string, unknown> = {}): Promise<string> {
    const v = await lifecycle.enqueue(createBody({ userId: await newUser(h.db), ...over }));
    await waitFor('ready', async () => (await row(v.sandboxId)).state === 'ready');
    return v.sandboxId;
  }

  beforeAll(async () => {
    pg = await startPg();
    h = pg.h;
    driver = new ScopedDriver(h.db);
    await driver.ensureNetwork();
    lifecycle = new Lifecycle({
      db: h.db,
      driver,
      budget: { memMb: 5120, cpu: 3.5, heavySlots: 1 },
      queueMax: 10,
      diskFreeGb: async () => 100,
      tickMs: 200,
    });
    lifecycle.onSandboxClosed((sid, reason) => closed.push([sid, reason]));
    lifecycle.start();
    gc = new Gc({ db: h.db, driver, lifecycle, connectionCount: () => conns });
    events = watchEvents({ driver, lifecycle });
    await events.ready;
  }, 180_000);

  afterAll(async () => {
    events?.stop();
    await gc?.close();
    await lifecycle?.close();
    if (h) {
      await sweep([...(await allRowIds(h.db)), ...(driver?.extra ?? [])]);
      await h.close();
    }
    await pg?.pg.stop();
  }, 120_000);

  test('expires_at in the past → after gcTick stopped/expired, container removed', async () => {
    const sid = await readySandbox();
    await h.db
      .update(sandboxes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sandboxes.id, sid));
    await gc.gcTick(Date.now());
    const r = await row(sid);
    expect(r.state).toBe('stopped');
    expect(r.stopReason).toBe('expired');
    expect(await containersOf(sid)).toEqual([]);
    expect(closed).toContainEqual([sid, 'expired']);
  });

  test('idle: kept while a terminal is connected, stopped/idle once none is', async () => {
    const sid = await readySandbox();
    await h.db
      .update(sandboxes)
      .set({ lastActivityAt: new Date(Date.now() - 11 * MIN) })
      .where(eq(sandboxes.id, sid));
    conns = 1;
    await gc.gcTick(Date.now());
    expect((await row(sid)).state).toBe('ready');
    conns = 0;
    await gc.gcTick(Date.now());
    expect(await row(sid)).toMatchObject({ state: 'stopped', stopReason: 'idle' });
  });

  test('disk over the quota → stopped/disk_quota (measured at most once a minute)', async () => {
    const sid = await readySandbox();
    const cid = (await row(sid)).containerId!;
    driver.diskMb.set(cid, 4000);
    await gc.gcTick(Date.now() + 2 * MIN);
    expect(await row(sid)).toMatchObject({ state: 'stopped', stopReason: 'disk_quota' });
  });

  test('a labelled container without a row, or with a stopped row → removed', async () => {
    const orphanId = randomUUID();
    driver.extra.add(orphanId);
    await driver.createContainer({
      sandboxId: orphanId,
      userId: null,
      image: 'rc/linux-base:24.04',
      class: 'light',
      hostname: 'orphan',
      limits: CLASS_LIMITS.light,
    });
    const sid = await readySandbox();
    // A stopped row whose container was left behind (e.g. a failed removal).
    await h.db.update(sandboxes).set({ state: 'stopped' }).where(eq(sandboxes.id, sid));
    expect(await containersOf(orphanId)).toHaveLength(1);
    expect(await containersOf(sid)).toHaveLength(1);
    await gc.gcTick(Date.now());
    expect(await containersOf(orphanId)).toEqual([]);
    expect(await containersOf(sid)).toEqual([]);
  });

  test('docker kill → failed/crashed within 5 s, usage booked, closed: sandbox_failed', async () => {
    const userId = await newUser(h.db);
    const sid = await readySandbox({ userId });
    await h.db
      .update(sandboxes)
      .set({ readyAt: new Date(Date.now() - 90_000) })
      .where(eq(sandboxes.id, sid));
    const cid = (await row(sid)).containerId!;
    const killed = Date.now();
    await docker.getContainer(cid).kill();
    await waitFor('failed', async () => (await row(sid)).state === 'failed', 5000);
    expect(Date.now() - killed).toBeLessThanOrEqual(5000);
    expect((await row(sid)).stopReason).toBe('crashed');
    expect(closed).toContainEqual([sid, 'sandbox_failed']);
    // Booked by the same failSandbox call, right after the state change.
    const u = await waitFor('usage', async () =>
      (await h.db.select().from(sandboxUsage).where(eq(sandboxUsage.userId, userId))).at(0),
    );
    expect(u.minutes).toBe(2);
    await waitFor('container removed', async () => (await containersOf(sid)).length === 0);
  });

  test('starting for over 5 min → failed through Lifecycle: start aborted, container gone', async () => {
    const v = await lifecycle.enqueue(
      createBody({ userId: await newUser(h.db), setupScript: 'sleep 60', setupTimeoutSec: 90 }),
    );
    const sid = v.sandboxId;
    await waitFor('container', async () => (await row(sid)).containerId);
    expect((await row(sid)).state).toBe('starting');
    const t0 = Date.now();
    await gc.gcTick(Date.now() + STARTING_TIMEOUT_MS + MIN);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(await row(sid)).toMatchObject({ state: 'failed', stopReason: 'start_timeout' });
    expect(await containersOf(sid)).toEqual([]);
  });
});
