import type { SandboxState } from '@rootcamp/api-contract';
import { sandboxes, type Db } from '@rootcamp/db';
import { inArray } from 'drizzle-orm';
import type { ManagedContainer, SandboxDriver } from './driver/types.js';
import type { Lifecycle, SandboxRow } from './lifecycle.js';
import { CALL_TIMEOUT_MS, withTimeout } from './timeout.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Spec §6.6: the GC pass period. */
export const GC_TICK_MS = 30_000;
/** §6.2 item 9: no terminal and no request for this long → `idle`. */
export const IDLE_MS = 10 * MINUTE_MS;
/** §6.3: writable layer + inner Docker above this → `disk_quota`. */
export const DISK_QUOTA_MB = 3072;
/** §6.3: disk is measured once a minute (it is the expensive part of a pass). */
export const DISK_CHECK_MS = 60_000;
/** §6.6: a row `starting` for longer than this → `failed`. */
export const STARTING_TIMEOUT_MS = 5 * MINUTE_MS;
/** §6.6: the daily prune runs at 04:00 MSK, i.e. 01:00 UTC (Moscow has no DST). */
const PRUNE_UTC_HOUR = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};
const silent: Log = { info() {}, warn() {}, error() {} };

// ---- the decision (pure) ------------------------------------------------------------------

export type GcRow = Pick<
  SandboxRow,
  'id' | 'containerId' | 'readyAt' | 'expiresAt' | 'lastActivityAt'
> & { state: 'starting' | 'ready' };

export type GcStopReason = 'expired' | 'idle' | 'disk_quota';

export interface GcInput {
  now: number;
  /** `starting` / `ready` rows, read BEFORE the containers were listed. */
  active: GcRow[];
  /** Every container carrying the `rootcamp.sandbox` label. */
  containers: ManagedContainer[];
  /** State of each row the listed containers name, read AFTER listing them. */
  containerRowStates: ReadonlyMap<string, SandboxState>;
  /** Open terminal WebSockets of a sandbox (Task 6). */
  connectionCount: (sandboxId: string) => number;
  /** The last pass that saw a terminal connected to the sandbox (in-memory). */
  lastConnectedAt: (sandboxId: string) => number | undefined;
  /**
   * Since when this GC has been watching connections (its first pass). Idle time is never
   * counted from before it: after a restart, terminals get a full 10 min to reconnect.
   */
  watchingSince: number;
  /** Disk measured in this pass, MiB (empty on passes that do not measure). */
  diskMb: ReadonlyMap<string, number>;
  /** When the row became `starting`, as far as this process knows. */
  startingSince: (sandboxId: string) => number | undefined;
}

export interface GcPlan {
  stop: { id: string; reason: GcStopReason }[];
  /** `starting` rows over the 5 min limit. */
  failStarting: string[];
  /** `ready` rows whose container is gone (`lost`) or not running (`crashed`). */
  dead: { id: string; containerId: string | null; reason: 'lost' | 'crashed' }[];
  /** Ids of labelled containers to remove. */
  orphans: string[];
}

/**
 * One GC pass (spec §6.6), decided from snapshots. The read order in `active` vs
 * `containerRowStates` matters: a row exists before its container and leaves `ready` before
 * its container is removed, so neither a fresh container nor one being stopped is misjudged.
 */
export function gcPlan(i: GcInput): GcPlan {
  const plan: GcPlan = { stop: [], failStarting: [], dead: [], orphans: [] };
  const byId = new Map<string, ManagedContainer>();
  for (const c of i.containers) byId.set(c.containerId, c);

  for (const r of i.active) {
    if (r.state === 'starting') {
      const since = i.startingSince(r.id);
      if (since !== undefined && i.now - since > STARTING_TIMEOUT_MS) plan.failStarting.push(r.id);
      continue;
    }
    const c = r.containerId ? byId.get(r.containerId) : undefined;
    if (!c) {
      plan.dead.push({ id: r.id, containerId: r.containerId, reason: 'lost' });
      continue;
    }
    if (!c.running) {
      plan.dead.push({ id: r.id, containerId: r.containerId, reason: 'crashed' });
      continue;
    }
    if (r.expiresAt && r.expiresAt.getTime() <= i.now) {
      plan.stop.push({ id: r.id, reason: 'expired' });
      continue;
    }
    if ((i.diskMb.get(r.id) ?? 0) > DISK_QUOTA_MB) {
      plan.stop.push({ id: r.id, reason: 'disk_quota' });
      continue;
    }
    // Idle runs from the latest of: input / requests, a connected terminal, the GC's start.
    const last = Math.max(
      (r.lastActivityAt ?? r.readyAt)?.getTime() ?? 0,
      i.lastConnectedAt(r.id) ?? 0,
      i.watchingSince,
    );
    if (i.connectionCount(r.id) === 0 && i.now - last > IDLE_MS) {
      plan.stop.push({ id: r.id, reason: 'idle' });
    }
  }

  for (const c of i.containers) {
    const state = UUID_RE.test(c.sandboxId) ? i.containerRowStates.get(c.sandboxId) : undefined;
    if (state === undefined || state === 'stopped' || state === 'failed') {
      plan.orphans.push(c.containerId);
    }
  }
  return plan;
}

/** The next 04:00 MSK strictly after `now`. */
export function nextPruneAt(now: number): number {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), PRUNE_UTC_HOUR);
  if (t <= now) t += DAY_MS;
  return t;
}

/**
 * §6.6 daily: `docker image prune -f --filter label!=rootcamp.keep` and `docker volume prune
 * -f` (see the driver for the exact filters). A failure of one does not skip the other.
 */
export async function dailyPrune(
  driver: Pick<SandboxDriver, 'pruneImages' | 'pruneVolumes'>,
  log: Pick<Log, 'info' | 'error'> = silent,
): Promise<void> {
  for (const [what, run] of [
    ['images', () => driver.pruneImages()],
    ['volumes', () => driver.pruneVolumes()],
  ] as const) {
    try {
      await run();
      log.info({ what }, 'daily prune done');
    } catch (err) {
      log.error({ err, what }, 'daily prune failed');
    }
  }
}

// ---- the collector ------------------------------------------------------------------------

export interface GcDeps {
  db: Db;
  driver: Pick<
    SandboxDriver,
    | 'listManaged'
    | 'stopAndRemove'
    | 'diskUsageMb'
    | 'containerState'
    | 'pruneImages'
    | 'pruneVolumes'
  >;
  lifecycle: Pick<Lifecycle, 'stopSandbox' | 'failSandbox' | 'startedAt'>;
  /**
   * Open terminal WebSockets of a sandbox. Task 6 owns the terminal and supplies it (here or
   * via `setConnectionCount`); the default counts none, so idleness then rests on
   * `last_activity_at` alone.
   */
  connectionCount?: (sandboxId: string) => number;
  /** Each disk measurement (MiB), e.g. for `Metrics.setDiskMb`. */
  onDiskUsage?: (sandboxId: string, mb: number) => void;
  /** Default `Date.now`; `gcTick(now)` overrides it per pass. */
  now?: () => number;
  log?: Log;
  /** Default `GC_TICK_MS`. */
  tickMs?: number;
  /** Limit per driver / lifecycle call (default `CALL_TIMEOUT_MS`, 20 s). */
  callTimeoutMs?: number;
}

/**
 * The garbage collector (spec §6.3 disk, §6.6): every 30 s stops expired, idle and over-quota
 * sandboxes, fails `starting` rows older than 5 min and `ready` rows whose container died
 * unnoticed, and removes orphan containers; once a day it prunes images and volumes. Every
 * transition goes through `Lifecycle` (closed events, usage, in-flight start aborts).
 */
export class Gc {
  private readonly now: () => number;
  private readonly log: Log;
  private connectionCount: (sandboxId: string) => number;
  /** First pass that saw a `starting` row this process is not starting itself. */
  private readonly seenStarting = new Map<string, number>();
  /** Last pass at which a ready sandbox had a terminal connected. */
  private readonly lastConnected = new Map<string, number>();
  /** Time of the first pass. */
  private watchingSince: number | undefined;
  private lastDiskAt: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private busy = false;
  private closed = false;

  constructor(private readonly deps: GcDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? silent;
    this.connectionCount = deps.connectionCount ?? (() => 0);
  }

  /** Task 6 hook: the terminal's live connection count per sandbox. */
  setConnectionCount(fn: (sandboxId: string) => number): void {
    this.connectionCount = fn;
  }

  /** The 30 s pass (first one now) and the daily prune. */
  start(): void {
    if (this.timer || this.closed) return;
    const pass = () => {
      if (this.busy) return; // a slow pass (many stops) is never stacked
      this.busy = true;
      this.gcTick()
        .catch((err: unknown) => this.log.error({ err }, 'gc pass failed'))
        .finally(() => (this.busy = false));
    };
    this.timer = setInterval(pass, this.deps.tickMs ?? GC_TICK_MS);
    this.timer.unref();
    pass();
    this.schedulePrune();
  }

  private schedulePrune(): void {
    if (this.closed) return;
    const now = this.now();
    this.pruneTimer = setTimeout(
      () => {
        void dailyPrune(this.deps.driver, this.log).finally(() => this.schedulePrune());
      },
      nextPruneAt(now) - now,
    );
    this.pruneTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.timer = this.pruneTimer = undefined;
    await this.chain.catch(() => {});
  }

  /** One pass at `now` (passes never overlap); resolves with what it decided. */
  gcTick(now = this.now()): Promise<GcPlan> {
    const run = this.chain.catch(() => {}).then(() => this.tickOnce(now));
    this.chain = run;
    return run;
  }

  /** Bounds a call so a hung dockerd request cannot keep a pass (and `busy`) forever. */
  private limit<T>(p: Promise<T>, what: string): Promise<T> {
    return withTimeout(p, this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS, what);
  }

  private async tickOnce(now: number): Promise<GcPlan> {
    const { db, driver, lifecycle } = this.deps;
    this.watchingSince ??= now;
    const active = (await db
      .select({
        id: sandboxes.id,
        state: sandboxes.state,
        containerId: sandboxes.containerId,
        readyAt: sandboxes.readyAt,
        expiresAt: sandboxes.expiresAt,
        lastActivityAt: sandboxes.lastActivityAt,
      })
      .from(sandboxes)
      .where(inArray(sandboxes.state, ['starting', 'ready']))) as GcRow[];
    const containers = await this.limit(driver.listManaged(), 'listManaged');
    const named = [...new Set(containers.map((c) => c.sandboxId).filter((s) => UUID_RE.test(s)))];
    const containerRowStates = new Map<string, SandboxState>(
      named.length === 0
        ? []
        : (
            await db
              .select({ id: sandboxes.id, state: sandboxes.state })
              .from(sandboxes)
              .where(inArray(sandboxes.id, named))
          ).map((r) => [r.id, r.state]),
    );

    const starting = new Set(active.filter((r) => r.state === 'starting').map((r) => r.id));
    for (const id of starting) if (!this.seenStarting.has(id)) this.seenStarting.set(id, now);
    for (const id of this.seenStarting.keys()) if (!starting.has(id)) this.seenStarting.delete(id);

    const conns = new Map<string, number>();
    for (const r of active) {
      if (r.state !== 'ready') continue;
      const n = this.connectionCount(r.id);
      conns.set(r.id, n);
      if (n > 0) this.lastConnected.set(r.id, now);
    }
    for (const id of this.lastConnected.keys()) if (!conns.has(id)) this.lastConnected.delete(id);

    const diskMb = new Map<string, number>();
    if (this.lastDiskAt === undefined || now - this.lastDiskAt >= DISK_CHECK_MS) {
      this.lastDiskAt = now;
      await Promise.all(
        active
          .filter((r) => r.state === 'ready' && r.containerId)
          .map(async (r) => {
            try {
              const mb = await this.limit(driver.diskUsageMb(r.containerId!), 'diskUsageMb');
              diskMb.set(r.id, mb);
              this.deps.onDiskUsage?.(r.id, mb);
            } catch {
              // Container gone meanwhile: the next pass sees it.
            }
          }),
      );
    }

    const plan = gcPlan({
      now,
      active,
      containers,
      containerRowStates,
      connectionCount: (id) => conns.get(id) ?? 0,
      lastConnectedAt: (id) => this.lastConnected.get(id),
      watchingSince: this.watchingSince,
      diskMb,
      startingSince: (id) => lifecycle.startedAt(id) ?? this.seenStarting.get(id),
    });

    const jobs: Promise<unknown>[] = [
      ...plan.stop.map(async ({ id, reason }) => {
        this.log.info({ sandboxId: id, reason }, 'gc: stopping sandbox');
        await this.limit(lifecycle.stopSandbox(id, reason), 'stopSandbox');
      }),
      ...plan.failStarting.map((id) =>
        this.limit(
          lifecycle.failSandbox(
            id,
            'start_timeout',
            `the sandbox did not become ready in ${STARTING_TIMEOUT_MS / MINUTE_MS} min`,
            { from: ['starting'] },
          ),
          'failSandbox',
        ),
      ),
      ...plan.dead.map(async (d) => {
        let reason: 'lost' | 'crashed' | 'oom' = d.reason;
        if (d.reason === 'crashed' && d.containerId) {
          const st = await this.limit(driver.containerState(d.containerId), 'containerState').catch(
            () => null,
          );
          if (st?.oomKilled) reason = 'oom';
        }
        await this.limit(
          lifecycle.failSandbox(
            d.id,
            reason,
            d.reason === 'lost'
              ? 'the sandbox container disappeared'
              : 'the sandbox container exited',
            { from: ['ready'], ...(d.containerId ? { containerId: d.containerId } : {}) },
          ),
          'failSandbox',
        );
      }),
      ...plan.orphans.map(async (cid) => {
        this.log.info({ containerId: cid }, 'gc: removing orphan container');
        await this.limit(driver.stopAndRemove(cid), 'stopAndRemove');
      }),
    ];
    for (const r of await Promise.allSettled(jobs)) {
      if (r.status === 'rejected') this.log.error({ err: r.reason }, 'gc action failed');
    }
    return plan;
  }
}
