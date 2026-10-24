import { EventEmitter } from 'node:events';
import { statfs } from 'node:fs/promises';
import type {
  CreateSandboxBody,
  ErrorCode,
  ExecCheck,
  ExecCheckResult,
  SandboxUsageDto,
  SandboxView,
  WsCloseReason,
} from '@rootcamp/api-contract';
import { SANDBOX_ACTIVE_STATES, sandboxes, settings, type Db } from '@rootcamp/db';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { CLASS_LIMITS, type ExecResult, type SandboxDriver } from './driver/types.js';
import { canEnqueue, plan, type ActiveRow, type Budget, type QueuedRow } from './scheduler.js';
import { recordUsage } from './usage.js';

export type SandboxRow = typeof sandboxes.$inferSelect;

/** Why a sandbox ended up `stopped` / `failed`: a WS close reason, or a lifecycle outcome. */
export type StopReason = WsCloseReason | 'queue_timeout';
export type FailReason =
  'setup_failed' | 'start_failed' | 'start_timeout' | 'lost' | 'oom' | 'crashed';

const MINUTE_MS = 60_000;
/** §6.2 item 4. */
export const BOOT_TIMEOUT_MS = 60_000;
/** §6.2 item 6. */
export const HARD_DEADLINE_MS = 90 * MINUTE_MS;
/** §6.2 item 8: extend is open when at most this much is left; it adds `EXTEND_MS`. */
export const EXTEND_WINDOW_MS = 10 * MINUTE_MS;
export const EXTEND_MS = 15 * MINUTE_MS;
/** `last_activity_at` is written at most this often. */
export const ACTIVITY_THROTTLE_MS = 30_000;
/** §6.5: the scheduler loop period. */
export const TICK_MS = 2000;
/** §6.7 item 3 / §9. */
export const CHECK_OUTPUT_CHARS = 300;
export const FAILURE_OUTPUT_CHARS = 2000;
/** Short housekeeping execs (title, history). */
const HOUSEKEEPING_TIMEOUT_SEC = 10;

/** States holding resources (admitted, container may exist). */
const HOLDING_STATES = ['starting', 'ready', 'stopping'] as const;

/** Error mapped onto `{ error: { code, message } }` by the internal routes. */
export class LifecycleError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * At most `n` UTF-16 code units of `s`, never ending in half a surrogate pair. Driver output is
 * already UTF-8-decoded with invalid bytes replaced (U+FFFD).
 */
export function clipChars(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const last = cut.charCodeAt(n - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The `output` of an exec-check result (§6.7 item 3, §9 "Проверка зависла"). */
export function checkOutput(r: ExecResult, timeoutSec: number): string {
  if (r.timedOut) return `проверка не уложилась в ${timeoutSec} с`;
  return clipChars(r.output, CHECK_OUTPUT_CHARS);
}

const statusOf = (err: unknown): number | undefined =>
  (err as { statusCode?: number } | null)?.statusCode;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};
const silent: Log = { info() {}, warn() {}, error() {} };

/** Free space on `path` (or `/` if it is missing), GiB. */
export async function diskFreeGbAt(path: string): Promise<number> {
  let s;
  try {
    s = await statfs(path);
  } catch {
    s = await statfs('/');
  }
  return (s.bavail * s.bsize) / 1024 ** 3;
}

export interface LifecycleDeps {
  db: Db;
  driver: SandboxDriver;
  budget: Budget;
  /** §6.5 item 5 (`QUEUE_MAX`). */
  queueMax: number;
  /** Default `Date.now`. */
  now?: () => number;
  /** Free disk for admissions; default: `statfs(hostRoot)`. */
  diskFreeGb?: () => Promise<number>;
  /** For the default `diskFreeGb` (`HOST_ROOT`). */
  hostRoot?: string;
  /** Live CPU / RAM of a ready sandbox for `SandboxView.usage` (Task 5 metrics); default null. */
  usageOf?: (sandboxId: string) => SandboxUsageDto | null;
  log?: Log;
  /** Scheduler period; default `TICK_MS`. */
  tickMs?: number;
}

interface StartRecord {
  promise: Promise<void>;
  aborted: boolean;
  containerId?: string;
  /** When this process began bringing the row up (`now()`), for the GC's 5 min limit. */
  startedAt: number;
}

export interface FailOptions {
  /** Source states the row may be in (default `starting` and `ready`). */
  from?: readonly ('starting' | 'ready')[];
  /** Only if the row still names this container (a `die` of a stale container is ignored). */
  containerId?: string;
  /** Usage of a `ready` row is booked up to this time (default now). */
  usageAt?: Date;
}

/**
 * Sandbox lifecycle (spec §6.2) and the scheduler loop (§6.5). Single writer of `sandboxes`
 * state transitions:
 *
 *   queued ─tick/plan.admit→ starting ─startSandbox→ ready ─stopSandbox→ stopping → stopped
 *     │ plan.timeout → stopped(queue_timeout)   │ setup≠0 → failed(setup_failed)
 *     │ stopSandbox → stopped                   │ create/boot error → failed(start_failed)
 *
 * Every transition is a conditional UPDATE on the expected source state, so concurrent
 * actors (scheduler, routes, Task 5's GC / events) never double-apply one.
 */
export class Lifecycle {
  private readonly db: Db;
  private readonly driver: SandboxDriver;
  private readonly now: () => number;
  private readonly diskFreeGb: () => Promise<number>;
  private readonly log: Log;
  private readonly events = new EventEmitter();
  private readonly starts = new Map<string, StartRecord>();
  /** Queue positions from the latest `plan()`. */
  private positions: Record<string, number> = {};
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private again = false;
  private closed = false;

  constructor(private readonly deps: LifecycleDeps) {
    this.db = deps.db;
    this.driver = deps.driver;
    this.now = deps.now ?? Date.now;
    this.diskFreeGb = deps.diskFreeGb ?? (() => diskFreeGbAt(deps.hostRoot ?? '/'));
    this.log = deps.log ?? silent;
    this.events.setMaxListeners(0);
  }

  // ---- events (Task 6 terminal, Task 5 GC subscribe / emit) -------------------------------

  /** A sandbox left `ready` (or earlier) for good; open terminals get `{t:'closed', reason}`. */
  onSandboxClosed(cb: (sandboxId: string, reason: WsCloseReason) => void): () => void {
    this.events.on('closed', cb);
    return () => this.events.off('closed', cb);
  }

  /** `expires_at` moved (extend); terminals send `{t:'extended'}`. */
  onSandboxExtended(cb: (sandboxId: string, expiresAt: Date) => void): () => void {
    this.events.on('extended', cb);
    return () => this.events.off('extended', cb);
  }

  emitClosed(sandboxId: string, reason: WsCloseReason): void {
    this.events.emit('closed', sandboxId, reason);
  }

  // ---- scheduler loop ---------------------------------------------------------------------

  /** Starts the 2 s loop (and runs a first tick now). */
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.wake(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref();
    this.wake();
  }

  /** Runs a scheduler tick soon ("a sandbox freed up", a new request). Never throws. */
  wake(): void {
    if (this.closed) return;
    this.tick().catch((err: unknown) => this.log.error({ err }, 'scheduler tick failed'));
  }

  /** One scheduler pass; concurrent calls coalesce into one extra pass. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.again = false;
          await this.tickOnce();
        } while (this.again && !this.closed);
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    const rows = await this.db
      .select()
      .from(sandboxes)
      .where(inArray(sandboxes.state, ['queued', ...HOLDING_STATES]));
    const queued: QueuedRow[] = [];
    const active: ActiveRow[] = [];
    for (const r of rows) {
      if (r.state === 'queued') {
        queued.push({
          id: r.id,
          class: r.class,
          cpu: r.cpu,
          memMb: r.memMb,
          queuedAt: r.queuedAt.getTime(),
          test: r.test,
        });
      } else {
        // `stopping` still holds its container until stopAndRemove returns.
        active.push({ class: r.class, cpu: r.cpu, memMb: r.memMb, test: r.test });
      }
    }
    if (queued.length === 0) {
      this.positions = {};
      return;
    }
    const [drained, diskFreeGb] = await Promise.all([this.drained(), this.diskFreeGb()]);
    const p = plan({
      queued,
      active,
      now: this.now(),
      diskFreeGb,
      budget: this.deps.budget,
      drained,
    });
    this.positions = p.positions;

    if (p.timeout.length > 0) {
      await this.db
        .update(sandboxes)
        .set({ state: 'stopped', stopReason: 'queue_timeout' })
        .where(and(inArray(sandboxes.id, p.timeout), eq(sandboxes.state, 'queued')));
    }
    for (const id of p.admit) {
      const [row] = await this.db
        .update(sandboxes)
        .set({ state: 'starting' })
        .where(and(eq(sandboxes.id, id), eq(sandboxes.state, 'queued')))
        .returning();
      if (row) this.startSandbox(row);
    }
  }

  /** `settings.sandboxes_drained` (written by `api`'s `sandboxes:drain`); absent → false. */
  private async drained(): Promise<boolean> {
    const [s] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'sandboxes_drained'));
    return s?.value === true;
  }

  /** Stops the loop and waits for in-flight starts and the current tick. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => {});
    await Promise.allSettled([...this.starts.values()].map((s) => s.promise));
  }

  // ---- requests ---------------------------------------------------------------------------

  /** `POST /internal/sandboxes`: a new `queued` row (the next tick admits it). */
  async enqueue(b: CreateSandboxBody): Promise<SandboxView> {
    const test = b.test === true;
    if (b.userId) {
      const [existing] = await this.db
        .select({ id: sandboxes.id })
        .from(sandboxes)
        .where(
          and(eq(sandboxes.userId, b.userId), inArray(sandboxes.state, SANDBOX_ACTIVE_STATES)),
        );
      if (existing) throw runExists();
    }
    let position: number | null = null;
    if (!test) {
      // Test rows are outside the queue: neither the length limit nor drain applies to them.
      const [{ n } = { n: 0 }] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(sandboxes)
        .where(and(eq(sandboxes.state, 'queued'), eq(sandboxes.test, false)));
      if (canEnqueue(n, await this.drained(), this.deps.queueMax) === 'queue_full') {
        throw new LifecycleError(409, 'queue_full', 'the sandbox queue is full');
      }
      position = n + 1;
    }
    const limits = CLASS_LIMITS[b.class];
    let row: SandboxRow | undefined;
    try {
      [row] = await this.db
        .insert(sandboxes)
        .values({
          runId: b.runId,
          userId: b.userId,
          image: b.image,
          class: b.class,
          cpu: limits.cpu,
          memMb: limits.memMb,
          title: b.title,
          test,
          hostname: b.hostname,
          setupScript: b.setupScript,
          setupTimeoutSec: b.setupTimeoutSec,
          ttlMin: b.ttlMin,
          queuedAt: new Date(this.now()),
        })
        .returning();
    } catch (err) {
      // Lost the race against a concurrent request: the partial unique index on user_id.
      if ((err as { code?: string }).code === '23505') throw runExists();
      throw err;
    }
    this.wake();
    return { ...this.toView(row!), queuePosition: position };
  }

  async get(id: string): Promise<SandboxRow | undefined> {
    const [row] = await this.db.select().from(sandboxes).where(eq(sandboxes.id, id));
    return row;
  }

  private async mustGet(id: string): Promise<SandboxRow> {
    const row = await this.get(id);
    if (!row) throw new LifecycleError(404, 'not_found', 'no such sandbox');
    return row;
  }

  async view(id: string): Promise<SandboxView> {
    return this.toView(await this.mustGet(id));
  }

  toView(r: SandboxRow): SandboxView {
    const now = this.now();
    const canExtend =
      r.state === 'ready' &&
      r.expiresAt !== null &&
      r.hardDeadline !== null &&
      r.expiresAt < r.hardDeadline &&
      r.expiresAt.getTime() > now &&
      r.expiresAt.getTime() - now <= EXTEND_WINDOW_MS;
    return {
      sandboxId: r.id,
      state: r.state,
      stopReason: r.stopReason,
      queuePosition: r.state === 'queued' ? (this.positions[r.id] ?? null) : null,
      expiresAt: iso(r.expiresAt),
      hardDeadline: iso(r.hardDeadline),
      readyAt: iso(r.readyAt),
      canExtend,
      usage: r.state === 'ready' ? (this.deps.usageOf?.(r.id) ?? null) : null,
    };
  }

  /** Bumps `last_activity_at` (at most once per 30 s); Task 6 calls it on terminal input. */
  async touch(id: string): Promise<void> {
    const now = new Date(this.now());
    const before = new Date(now.getTime() - ACTIVITY_THROTTLE_MS);
    await this.db
      .update(sandboxes)
      .set({ lastActivityAt: now })
      .where(
        and(
          eq(sandboxes.id, id),
          or(isNull(sandboxes.lastActivityAt), lt(sandboxes.lastActivityAt, before)),
        ),
      );
  }

  /** `POST …/exec-checks`: the checks run one after another (§6.7). */
  async execChecks(id: string, checks: ExecCheck[]): Promise<ExecCheckResult[]> {
    const row = await this.mustGet(id);
    if (row.state !== 'ready' || !row.containerId) {
      throw new LifecycleError(409, 'validation', `sandbox is ${row.state}, not ready`);
    }
    const results: ExecCheckResult[] = [];
    for (const c of checks) {
      const r = await this.driver.exec(row.containerId, c.script, { timeoutSec: c.timeoutSec });
      results.push({
        goalId: c.goalId,
        exitCode: r.exitCode,
        output: checkOutput(r, c.timeoutSec),
        timedOut: r.timedOut,
      });
    }
    return results;
  }

  /** `POST …/extend` (§6.2 item 8). */
  async extend(id: string): Promise<Date> {
    const row = await this.mustGet(id);
    const now = this.now();
    const exp = row.expiresAt;
    const hard = row.hardDeadline;
    if (row.state !== 'ready' || !exp || !hard) {
      throw new LifecycleError(409, 'extend_not_allowed', `sandbox is ${row.state}`);
    }
    if (exp >= hard) {
      throw new LifecycleError(409, 'extend_not_allowed', 'the hard deadline is reached');
    }
    if (exp.getTime() <= now) {
      // Already expired; GC stops it on its next pass.
      throw new LifecycleError(409, 'extend_not_allowed', 'the sandbox has expired');
    }
    if (exp.getTime() - now > EXTEND_WINDOW_MS) {
      throw new LifecycleError(409, 'extend_not_allowed', 'more than 10 minutes left');
    }
    const next = new Date(Math.min(exp.getTime() + EXTEND_MS, hard.getTime()));
    const [updated] = await this.db
      .update(sandboxes)
      .set({ expiresAt: next })
      .where(and(eq(sandboxes.id, id), eq(sandboxes.state, 'ready'), eq(sandboxes.expiresAt, exp)))
      .returning({ id: sandboxes.id });
    if (!updated) throw new LifecycleError(409, 'extend_not_allowed', 'sandbox changed meanwhile');
    this.events.emit('extended', id, next);
    return next;
  }

  // ---- start / stop -----------------------------------------------------------------------

  /**
   * Brings a `starting` row up in the background: container → boot wait → title → setup →
   * history wipe → `ready`. The promise is tracked so `stopSandbox` / `close` can wait for it.
   */
  startSandbox(row: SandboxRow): void {
    const rec: StartRecord = { promise: Promise.resolve(), aborted: false, startedAt: this.now() };
    rec.promise = this.runStart(row, rec)
      .catch((err: unknown) => this.log.error({ err, sandboxId: row.id }, 'sandbox start crashed'))
      .finally(() => this.starts.delete(row.id));
    this.starts.set(row.id, rec);
  }

  private async runStart(row: SandboxRow, rec: StartRecord): Promise<void> {
    let containerId: string | undefined;
    try {
      containerId = await this.createContainer(row);
      rec.containerId = containerId;
      // Unconditional: whoever moved the row on (stop, GC) needs the id to remove it.
      await this.db.update(sandboxes).set({ containerId }).where(eq(sandboxes.id, row.id));
      if (rec.aborted) return;

      await this.driver.waitBoot(containerId, BOOT_TIMEOUT_MS);
      if (rec.aborted) return;

      await this.driver.exec(
        containerId,
        'mkdir -p /etc/rootcamp && printf %s "$TITLE" > /etc/rootcamp/title',
        { timeoutSec: HOUSEKEEPING_TIMEOUT_SEC, env: [`TITLE=${row.title}`] },
      );
      // exec keeps stdout only; the alert wants stderr too (failure_output).
      const setup = await this.driver.exec(containerId, `exec 2>&1\n${row.setupScript}`, {
        timeoutSec: row.setupTimeoutSec,
      });
      if (rec.aborted) return;
      if (setup.exitCode !== 0) {
        const out = setup.timedOut
          ? `${setup.output}\n[setup timed out after ${row.setupTimeoutSec} s]`
          : setup.output;
        await this.fail(row.id, 'setup_failed', out, containerId);
        return;
      }
      await this.driver.exec(containerId, 'history -c; rm -f /root/.bash_history', {
        timeoutSec: HOUSEKEEPING_TIMEOUT_SEC,
      });
      if (rec.aborted) return;

      const now = this.now();
      const [ready] = await this.db
        .update(sandboxes)
        .set({
          state: 'ready',
          readyAt: new Date(now),
          expiresAt: new Date(now + row.ttlMin * MINUTE_MS),
          hardDeadline: new Date(now + HARD_DEADLINE_MS),
          lastActivityAt: new Date(now),
        })
        .where(and(eq(sandboxes.id, row.id), eq(sandboxes.state, 'starting')))
        .returning({ id: sandboxes.id });
      if (ready) {
        this.log.info({ sandboxId: row.id }, 'sandbox ready');
      } else {
        // The row moved on meanwhile (stop, GC fail): nobody else will remove this container.
        await this.removeContainer(row.id, containerId);
      }
    } catch (err) {
      if (rec.aborted) return;
      this.log.error({ err, sandboxId: row.id }, 'sandbox failed to start');
      await this.fail(row.id, 'start_failed', (err as Error).message ?? String(err), containerId);
    }
  }

  /**
   * Creates the container. A leftover container of the same sandbox (same `rc-sbx-<8>` name,
   * e.g. after a crash mid-start) makes dockerd answer 409: it is removed and the create is
   * retried once. A name clash with another sandbox's container fails the start.
   */
  private async createContainer(row: SandboxRow): Promise<string> {
    const spec = {
      sandboxId: row.id,
      userId: row.userId,
      image: row.image,
      class: row.class,
      hostname: row.hostname,
      limits: CLASS_LIMITS[row.class],
    };
    try {
      return await this.driver.createContainer(spec);
    } catch (err) {
      if (statusOf(err) !== 409) throw err;
      const stale = (await this.driver.listManaged()).filter((c) => c.sandboxId === row.id);
      if (stale.length === 0) throw err;
      this.log.warn(
        { sandboxId: row.id, stale: stale.length },
        'removing a stale sandbox container',
      );
      for (const c of stale) await this.driver.stopAndRemove(c.containerId);
      return this.driver.createContainer(spec);
    }
  }

  /**
   * `starting` → `failed(reason)`. The container goes first, so a row seen as `failed` never
   * still has one (GC would remove a leftover anyway).
   */
  async fail(
    id: string,
    reason: FailReason,
    output: string | null,
    containerId?: string,
  ): Promise<void> {
    if (containerId) await this.removeContainer(id, containerId);
    await this.db
      .update(sandboxes)
      .set({
        state: 'failed',
        stopReason: reason,
        failureOutput: output === null ? null : clipChars(output, FAILURE_OUTPUT_CHARS),
      })
      .where(and(eq(sandboxes.id, id), eq(sandboxes.state, 'starting')));
    this.wake();
  }

  /** When this process started bringing `id` up; undefined if no start is in flight. */
  startedAt(id: string): number | undefined {
    return this.starts.get(id)?.startedAt;
  }

  /**
   * `starting` / `ready` → `failed(reason)` for Task 5: a container that died (`oom`,
   * `crashed`), a start that took too long (`start_timeout`), a sandbox lost across a restart
   * (`lost`). Terminals get `closed: sandbox_failed`; an in-flight start is aborted; the
   * container is removed; a `ready` row's minutes are booked like a stop's. Resolves false when
   * the row was not in a source state (or names another container).
   */
  async failSandbox(
    id: string,
    reason: FailReason,
    output: string | null,
    o: FailOptions = {},
  ): Promise<boolean> {
    const from = o.from ?? (['starting', 'ready'] as const);
    const [row] = await this.db
      .update(sandboxes)
      .set({
        state: 'failed',
        stopReason: reason,
        failureOutput: output === null ? null : clipChars(output, FAILURE_OUTPUT_CHARS),
      })
      .where(
        and(
          eq(sandboxes.id, id),
          inArray(sandboxes.state, [...from]),
          o.containerId ? eq(sandboxes.containerId, o.containerId) : undefined,
        ),
      )
      .returning();
    if (!row) return false;
    this.log.warn({ sandboxId: id, reason }, 'sandbox failed');
    this.emitClosed(id, 'sandbox_failed');
    // ready_at is set only by the ready transition, so it marks a row that was ready. Booked
    // once: only the call whose conditional update matched gets here.
    if (row.readyAt) await recordUsage(this.db, row, o.usageAt ?? new Date(this.now()));

    const start = this.starts.get(id);
    if (start) {
      start.aborted = true;
      if (start.containerId) await this.removeContainer(id, start.containerId);
      await start.promise;
    }
    const containerId = start?.containerId ?? (await this.get(id))?.containerId ?? row.containerId;
    if (containerId) await this.removeContainer(id, containerId);
    this.wake();
    return true;
  }

  /**
   * `queued` / `starting` / `ready` → `stopping` → (`docker stop -t 10`, `rm -v`) → `stopped`,
   * then books the minutes. Emits `closed(reason)` first so terminals close before the
   * container goes. Resolves `false` when the sandbox was not active (already stopping or done).
   */
  async stopSandbox(id: string, reason: WsCloseReason): Promise<boolean> {
    const [row] = await this.db
      .update(sandboxes)
      .set({ state: 'stopping', stopReason: reason })
      .where(and(eq(sandboxes.id, id), inArray(sandboxes.state, SANDBOX_ACTIVE_STATES)))
      .returning({ id: sandboxes.id });
    if (!row) {
      await this.mustGet(id);
      return false;
    }
    this.emitClosed(id, reason);

    const start = this.starts.get(id);
    if (start) {
      // Mid-start: tell the starter to give up, kill its container (any running exec ends
      // with it), and wait until it has let go.
      start.aborted = true;
      if (start.containerId) await this.removeContainer(id, start.containerId);
      await start.promise;
    }
    await this.completeStop(id, start?.containerId);
    return true;
  }

  /**
   * The second half of a stop: removes the container of a `stopping` row, moves it to
   * `stopped` and books the minutes. Also used by reconcile for a stop a previous process
   * left unfinished. Resolves false when the row was not `stopping`.
   */
  async completeStop(id: string, knownContainerId?: string): Promise<boolean> {
    const containerId = (await this.get(id))?.containerId ?? knownContainerId;
    if (containerId) await this.removeContainer(id, containerId);

    const stoppedAt = new Date(this.now());
    const [stopped] = await this.db
      .update(sandboxes)
      .set({ state: 'stopped' })
      .where(and(eq(sandboxes.id, id), eq(sandboxes.state, 'stopping')))
      .returning();
    if (stopped) await recordUsage(this.db, stopped, stoppedAt);
    this.wake();
    return stopped !== undefined;
  }

  /** A failed removal is logged; Task 5's GC removes containers whose row is stopped/failed. */
  private async removeContainer(id: string, containerId: string): Promise<void> {
    await this.driver
      .stopAndRemove(containerId)
      .catch((err: unknown) => this.log.error({ err, sandboxId: id }, 'stopAndRemove failed'));
  }
}

const runExists = () =>
  new LifecycleError(409, 'run_exists', 'the user already has an active sandbox');
