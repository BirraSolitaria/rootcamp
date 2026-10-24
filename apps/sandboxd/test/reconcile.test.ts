import { randomUUID } from 'node:crypto';
import type { WsCloseReason } from '@rootcamp/api-contract';
import { sandboxUsage, sandboxes, type DbHandle } from '@rootcamp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CLASS_LIMITS } from '../src/driver/types.js';
import { Lifecycle } from '../src/lifecycle.js';
import { reconcileOnStart } from '../src/reconcile.js';
import {
  ScopedDriver,
  allRowIds,
  containersOf,
  dockerAvailable,
  newUser,
  startPg,
  sweep,
  type Pg,
} from './helpers/stack.js';

const MIN = 60_000;

describe.runIf(dockerAvailable)('reconcileOnStart (runc-dev, real Postgres)', () => {
  let pg: Pg;
  let h: DbHandle;
  let driver: ScopedDriver;
  let lifecycle: Lifecycle;
  const closed: [string, WsCloseReason][] = [];

  const row = async (sid: string) =>
    (await h.db.select().from(sandboxes).where(eq(sandboxes.id, sid)))[0]!;

  /** A row as a previous sandboxd process left it, optionally with a live container. */
  async function leftover(
    state: 'starting' | 'ready' | 'stopping',
    o: { container?: boolean; userId?: string | null; readyAgoMs?: number } = {},
  ): Promise<string> {
    const now = Date.now();
    const readyAt = state === 'starting' ? null : new Date(now - (o.readyAgoMs ?? 5 * MIN));
    const [r] = await h.db
      .insert(sandboxes)
      .values({
        runId: randomUUID(),
        userId: o.userId ?? null,
        image: 'rc/linux-base:24.04',
        class: 'light',
        cpu: CLASS_LIMITS.light.cpu,
        memMb: CLASS_LIMITS.light.memMb,
        state,
        hostname: 'web-01',
        setupScript: 'true',
        setupTimeoutSec: 30,
        ttlMin: 30,
        readyAt,
        expiresAt: readyAt && new Date(readyAt.getTime() + 30 * MIN),
        hardDeadline: readyAt && new Date(readyAt.getTime() + 90 * MIN),
        lastActivityAt: readyAt,
        containerId: 'f'.repeat(64),
      })
      .returning();
    const sid = r!.id;
    if (o.container) {
      const containerId = await driver.createContainer({
        sandboxId: sid,
        userId: null,
        image: 'rc/linux-base:24.04',
        class: 'light',
        hostname: 'web-01',
        limits: CLASS_LIMITS.light,
      });
      await h.db.update(sandboxes).set({ containerId }).where(eq(sandboxes.id, sid));
    }
    return sid;
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
    });
    lifecycle.onSandboxClosed((sid, reason) => closed.push([sid, reason]));
  }, 180_000);

  afterAll(async () => {
    await lifecycle?.close();
    if (h) {
      await sweep(await allRowIds(h.db));
      await h.close();
    }
    await pg?.pg.stop();
  }, 120_000);

  test('ready without a container → failed/lost; a live ready one is adopted', async () => {
    const userId = await newUser(h.db);
    const lost = await leftover('ready', { userId, readyAgoMs: 3 * MIN + 1000 });
    const live = await leftover('ready', { container: true });
    const starting = await leftover('starting', { container: true });
    const stopping = await leftover('stopping', { container: true });

    const r = await reconcileOnStart({ db: h.db, driver, lifecycle });

    expect(await row(lost)).toMatchObject({ state: 'failed', stopReason: 'lost' });
    expect(closed).toContainEqual([lost, 'sandbox_failed']);
    // The minutes it ran are still booked (up to now, at most to expires_at).
    const [u] = await h.db.select().from(sandboxUsage).where(eq(sandboxUsage.userId, userId));
    expect(u?.minutes).toBe(4);

    expect(await row(live)).toMatchObject({ state: 'ready' });
    expect(await containersOf(live)).toHaveLength(1);

    // Nobody is bringing a `starting` row up any more: lost, container removed.
    expect(await row(starting)).toMatchObject({ state: 'failed', stopReason: 'lost' });
    expect(await containersOf(starting)).toEqual([]);

    // An interrupted stop is finished.
    expect((await row(stopping)).state).toBe('stopped');
    expect(await containersOf(stopping)).toEqual([]);

    expect(r.adopted).toEqual([live]);
    expect([...r.lost].sort()).toEqual([lost, starting].sort());
    expect(r.stopped).toEqual([stopping]);
  });
});
