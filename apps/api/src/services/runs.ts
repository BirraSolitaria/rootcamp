// Practice runs (spec §5.1 «Практика», §6.2, §6.7, §9). `practice_runs` is the api's view of an
// attempt; `sandboxes` belongs to sandboxd, reached through `SandboxdClient`. The run's status
// follows its sandbox (`runStatusOf`) until it ends; `solved` is set here by `check`.
//
// Locks: creating a run locks the user's `users` row (serialises a user's creates); `check`
// locks the run row, then `practice_progress`, `streaks`, `users` (via applyXp) — the same
// relative order as lessons.ts (streaks before users), so the two never deadlock.
import { randomUUID } from 'node:crypto';
import type {
  CheckResponse,
  CreateRunResponse,
  CreateSandboxBody,
  ExtendRunResponse,
  HintResponse,
  PracticeSummaryDto,
  ResetRunResponse,
  RunDto,
  RunState,
  SandboxView,
  TerminalTicketResponse,
  WsCloseReason,
} from '@rootcamp/api-contract';
import { signTicket } from '@rootcamp/api-contract/ticket';
import {
  practiceProgress,
  practiceRuns,
  sandboxes,
  sandboxUsage,
  streaks,
  users,
  type Db,
} from '@rootcamp/db';
import {
  DAILY_GOAL,
  grantReward,
  practiceAvailability,
  practiceXp,
  toDateKey,
} from '@rootcamp/logic';
import { and, asc, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { enforce } from '../plugins/rateLimit.js';
import { HttpError, rateLimited } from '../plugins/errors.js';
import type { ContentHolder, ContentStore, ServerPractice } from './contentStore.js';
import type { Executor } from './executor.js';
import type { Limiters } from './limiter.js';
import { locatePractice } from './practices.js';
import { completedLessonIds } from './progress.js';
import { applyXp, xpOnDay } from './rewards.js';
import { SandboxdError, type SandboxdClient } from './sandboxdClient.js';

/** pg-boss queue: stops a solved run's sandbox once the user has seen the result. */
export const STOP_SOLVED_QUEUE = 'stop-solved';
/** pg-boss queue: once a minute, brings unfinished runs in line with their sandboxes. */
export const RUNS_SYNC_QUEUE = 'runs-sync';

/** Spec §6.2, §5.1 and the plan's global constraints. */
export const RUN_LIMITS = {
  /** Sandbox minutes per user per day (user's zone). */
  quotaMinutesPerDay: 180,
  /** Runs created per user per rolling hour. */
  runsPerHour: 6,
  resetsPerRun: 3,
  /** `stop-solved` delay: the user sees the result first (§6.2 step 9). */
  stopSolvedAfterSec: 120,
  ticketTtlMs: 30_000,
  /** A `queued` run that never got a sandbox (api died mid-create) is failed after this. */
  orphanRunMs: 5 * 60_000,
  /** A solved run's sandbox younger than this is released before the user's next run. */
  solvedReleaseWindowMs: 10 * 60_000,
} as const;

const HOUR_MS = 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE: readonly RunState[] = ['queued', 'starting', 'ready'];
/** States in which the sandbox may still be up and usable (terminal, checks, extend). */
const LIVE: readonly RunState[] = ['ready', 'solved'];

type RunRow = typeof practiceRuns.$inferSelect;

export interface StopSolvedJob {
  runId: string;
  sandboxId: string;
}

export interface RunsLog {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * `practice_runs.status` for a sandbox state (brief table): `queued/starting/ready` as is;
 * `stopped` (and `stopping`, which already carries its reason) by stop reason — `expired`,
 * `solved`, `queue_timeout`, else `stopped`; `failed` → `failed`.
 */
export function runStatusOf(view: Pick<SandboxView, 'state' | 'stopReason'>): RunState {
  switch (view.state) {
    case 'queued':
    case 'starting':
    case 'ready':
      return view.state;
    case 'failed':
      return 'failed';
    case 'stopping':
    case 'stopped':
      if (view.stopReason === 'expired') return 'expired';
      if (view.stopReason === 'solved') return 'solved';
      if (view.stopReason === 'queue_timeout') return 'queue_timeout';
      return 'stopped';
  }
}

const isActive = (s: RunState) => ACTIVE.includes(s);

function noSandboxd(): HttpError {
  return new HttpError(503, 'queue_full', 'practice sandboxes are not available on this server');
}

/** A sandboxd failure as a §9 answer. */
function fromSandboxd(err: unknown): HttpError {
  if (!(err instanceof SandboxdError)) throw err;
  switch (err.code) {
    case 'queue_full':
      return new HttpError(409, 'queue_full', 'all sandboxes are busy, try again in 10 minutes');
    case 'extend_not_allowed':
      return new HttpError(409, 'extend_not_allowed', 'the sandbox cannot be extended now');
    case 'run_exists':
      return new HttpError(409, 'run_exists', 'another sandbox of yours is still running');
    default:
      return new HttpError(503, 'internal', 'the sandbox service is unavailable, try again');
  }
}

function notReady(): HttpError {
  return new HttpError(409, 'validation', 'the sandbox is not ready');
}

export interface RunsDeps {
  db: Db;
  content: ContentHolder;
  /** Unset (no `SANDBOXD_URL`): run routes answer `503 queue_full`, listing still works. */
  sandboxd?: SandboxdClient;
  /** pg-boss for `stop-solved`; null (tests) → the solved sandbox lives out its TTL / idle. */
  boss: Pick<PgBoss, 'send'> | null;
  now: () => number;
  ticketSecret: string;
  limiters: Pick<Limiters, 'practiceCheck' | 'practiceHints'>;
  log?: RunsLog;
}

export interface RunUser {
  id: string;
  tz: string;
}

/** Background part, shared by the routes and the jobs: needs no content. */
export function createRunSync(deps: Pick<RunsDeps, 'db' | 'sandboxd' | 'now' | 'log'>) {
  const { db } = deps;

  /**
   * Brings an unfinished run in line with its sandbox and returns the row plus the sandbox view
   * (null when there is none or it could not be read and the run is over anyway). A finished run
   * keeps its status; `solved` still reads the view (the sandbox lives 2 more minutes). The old
   * sandbox of a reset (`stopReason: 'reset'`) never ends the run. `passive`: background polling
   * that must not count as user activity.
   */
  async function syncRun(
    row: RunRow,
    passive: boolean,
  ): Promise<{ row: RunRow; view: SandboxView | null }> {
    const client = deps.sandboxd;
    if (!client || !row.sandboxId) return { row, view: null };
    const active = isActive(row.status);
    let view: SandboxView;
    try {
      view = await client.get(row.sandboxId, { passive: passive || !active });
    } catch (err) {
      if (err instanceof SandboxdError && err.status === 404 && active) {
        return { row: await setStatus(row, 'failed'), view: null };
      }
      if (!active) return { row, view: null };
      throw fromSandboxd(err);
    }
    if (!active || view.stopReason === 'reset') return { row, view };
    const next = runStatusOf(view);
    if (next === row.status) return { row, view };
    return { row: await setStatus(row, next), view };
  }

  /** Conditional on the row's current status and sandbox, so a reset or check in between wins. */
  async function setStatus(row: RunRow, status: RunState): Promise<RunRow> {
    const ended = !isActive(status);
    const [updated] = await db
      .update(practiceRuns)
      .set({ status, endedAt: ended ? new Date(deps.now()) : null })
      .where(
        and(
          eq(practiceRuns.id, row.id),
          eq(practiceRuns.status, row.status),
          row.sandboxId === null
            ? sql`${practiceRuns.sandboxId} is null`
            : eq(practiceRuns.sandboxId, row.sandboxId),
        ),
      )
      .returning();
    if (updated) return updated;
    const [current] = await db.select().from(practiceRuns).where(eq(practiceRuns.id, row.id));
    return current ?? row;
  }

  /** Run id → when a pass first saw it active without a sandbox (this process only). */
  const orphanSince = new Map<string, number>();

  /**
   * `runs-sync`: every unfinished run against its sandbox (passive reads). An active run that
   * stays without a sandbox for more than `orphanRunMs` lost its create or reset (api restart)
   * and is failed: a fresh `queued` run counted from `created_at`, a claimed reset from the first
   * pass that saw it. Errors on one run are logged and do not stop the others. A no-op without
   * sandboxd.
   */
  async function syncOpenRuns(): Promise<{ checked: number; changed: number }> {
    if (!deps.sandboxd) return { checked: 0, changed: 0 };
    const rows = await db
      .select()
      .from(practiceRuns)
      .where(inArray(practiceRuns.status, [...ACTIVE]));
    let changed = 0;
    const at = deps.now();
    for (const id of orphanSince.keys()) {
      if (!rows.some((r) => r.id === id && r.sandboxId === null)) orphanSince.delete(id);
    }
    for (const row of rows) {
      try {
        if (!row.sandboxId) {
          // No sandbox: a create or reset is in flight, or the api died during one. A fresh
          // `queued` run counts from its creation; a claimed reset from when a pass first saw it.
          const fresh = row.status === 'queued' && row.resets === 0;
          const since = orphanSince.get(row.id) ?? (fresh ? row.createdAt.getTime() : at);
          orphanSince.set(row.id, since);
          if (at - since > RUN_LIMITS.orphanRunMs) {
            await setStatus(row, 'failed');
            orphanSince.delete(row.id);
            changed++;
          }
          continue;
        }
        const { row: after } = await syncRun(row, true);
        if (after.status !== row.status) changed++;
      } catch (err) {
        deps.log?.warn({ err, runId: row.id }, 'runs-sync: run not synced');
      }
    }
    return { checked: rows.length, changed };
  }

  /** `stop-solved`: stops the solved sandbox (idempotent; an unknown one is already gone). */
  async function stopSolved(job: StopSolvedJob): Promise<void> {
    if (!deps.sandboxd) return;
    try {
      await deps.sandboxd.remove(job.sandboxId, 'solved');
    } catch (err) {
      if (err instanceof SandboxdError && err.status === 404) return;
      throw err;
    }
  }

  return { syncRun, syncOpenRuns, stopSolved };
}

export type RunSync = ReturnType<typeof createRunSync>;

/** The run endpoints of §5.1 for one app instance. */
export function createRunService(deps: RunsDeps) {
  const { db, now } = deps;
  const sync = createRunSync(deps);

  function client(): SandboxdClient {
    if (!deps.sandboxd) throw noSandboxd();
    return deps.sandboxd;
  }

  async function loadRun(user: RunUser, runId: string): Promise<RunRow> {
    if (!UUID.test(runId)) throw new HttpError(404, 'not_found', 'run not found');
    const [row] = await db
      .select()
      .from(practiceRuns)
      .where(and(eq(practiceRuns.id, runId), eq(practiceRuns.userId, user.id)));
    if (!row) throw new HttpError(404, 'not_found', 'run not found');
    return row;
  }

  function practiceOf(store: ContentStore, practiceId: string): ServerPractice {
    const practice = store.practice(practiceId);
    if (!practice) throw new HttpError(404, 'not_found', 'practice not found');
    return practice;
  }

  function sandboxBody(runId: string, userId: string, p: ServerPractice): CreateSandboxBody {
    const m = p.manifest;
    return {
      runId,
      userId,
      image: m.image,
      class: m.class,
      hostname: m.hostname,
      title: m.title,
      setupScript: p.files['setup.sh'] ?? '',
      setupTimeoutSec: m.setupTimeoutSec,
      ttlMin: m.timeoutMin,
    };
  }

  async function progressOf(tx: Executor, userId: string, practiceId: string, lock = false) {
    await tx.insert(practiceProgress).values({ userId, practiceId }).onConflictDoNothing();
    const q = tx
      .select()
      .from(practiceProgress)
      .where(and(eq(practiceProgress.userId, userId), eq(practiceProgress.practiceId, practiceId)));
    const [row] = lock ? await q.for('update') : await q;
    return row!;
  }

  /** Stops sandboxes of the user's recently solved runs still waiting for `stop-solved`. */
  async function releaseSolved(userId: string, at: number): Promise<void> {
    const solved = await db
      .select({ id: practiceRuns.id, sandboxId: practiceRuns.sandboxId })
      .from(practiceRuns)
      .where(
        and(
          eq(practiceRuns.userId, userId),
          eq(practiceRuns.status, 'solved'),
          isNotNull(practiceRuns.sandboxId),
          gt(practiceRuns.endedAt, new Date(at - RUN_LIMITS.solvedReleaseWindowMs)),
        ),
      );
    for (const r of solved) await sync.stopSolved({ runId: r.id, sandboxId: r.sandboxId! });
  }

  /**
   * `POST /api/practices/:id/runs`. In order: unknown practice → 404; not available on the path
   * → `403 practice_locked`; an active run (after a sync with its sandbox) → `409 run_exists`
   * with its `runId`; today's `sandbox_usage` ≥ 180 min → `403 quota_exceeded`; 6 runs in the
   * last hour → `429 rate_limited`. Then `practice_runs(queued)` and `sandboxd.create`; a refused
   * create (`queue_full`, …) removes the run row again, so it counts for nothing.
   */
  async function createRun(user: RunUser, practiceId: string): Promise<CreateRunResponse> {
    const sandboxd = client();
    const store = deps.content.current();
    const practice = practiceOf(store, practiceId);
    const where = locatePractice(store, practiceId);
    if (!where) throw new HttpError(404, 'not_found', 'practice not found');
    const done = await completedLessonIds(db, store, user.id);
    if (practiceAvailability(where.track, done)[practiceId] !== 'available') {
      throw new HttpError(403, 'practice_locked', 'complete the lesson before this practice');
    }

    const activeRuns = () =>
      db
        .select()
        .from(practiceRuns)
        .where(and(eq(practiceRuns.userId, user.id), inArray(practiceRuns.status, [...ACTIVE])));
    for (const row of await activeRuns()) await sync.syncRun(row, true);

    const at = now();
    const runId = await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update');
      const [active] = await tx
        .select({ id: practiceRuns.id })
        .from(practiceRuns)
        .where(and(eq(practiceRuns.userId, user.id), inArray(practiceRuns.status, [...ACTIVE])));
      if (active) {
        throw new HttpError(409, 'run_exists', 'you already have a running practice', {
          runId: active.id,
        });
      }
      const [usage] = await tx
        .select({ minutes: sandboxUsage.minutes })
        .from(sandboxUsage)
        .where(and(eq(sandboxUsage.userId, user.id), eq(sandboxUsage.day, toDateKey(at, user.tz))));
      if ((usage?.minutes ?? 0) >= RUN_LIMITS.quotaMinutesPerDay) {
        throw new HttpError(403, 'quota_exceeded', 'the daily sandbox time is used up');
      }
      const recent = await tx
        .select({ createdAt: practiceRuns.createdAt })
        .from(practiceRuns)
        .where(
          and(eq(practiceRuns.userId, user.id), gt(practiceRuns.createdAt, new Date(at - HOUR_MS))),
        )
        .orderBy(asc(practiceRuns.createdAt));
      if (recent.length >= RUN_LIMITS.runsPerHour) {
        const oldest = recent[recent.length - RUN_LIMITS.runsPerHour]!.createdAt.getTime();
        throw rateLimited(oldest + HOUR_MS - at, 'too many practice runs, try again later');
      }
      const [row] = await tx
        .insert(practiceRuns)
        .values({
          userId: user.id,
          practiceId,
          contentVersion: store.version,
          status: 'queued',
          createdAt: new Date(at),
        })
        .returning({ id: practiceRuns.id });
      return row!.id;
    });

    let view: SandboxView;
    try {
      await releaseSolved(user.id, at);
      view = await sandboxd.create(sandboxBody(runId, user.id, practice));
    } catch (err) {
      await db.delete(practiceRuns).where(eq(practiceRuns.id, runId));
      if (err instanceof SandboxdError && err.code === 'run_exists') {
        const other = await activeRunIdOf(user.id, runId);
        throw new HttpError(
          409,
          'run_exists',
          'another sandbox of yours is still running',
          other ? { runId: other } : undefined,
        );
      }
      throw err instanceof HttpError ? err : fromSandboxd(err);
    }
    const state = runStatusOf(view);
    const attached = await attachSandbox(runId, 'queued', view);
    if (!attached) {
      // Stopped while the create was in flight: the new sandbox must not outlive the run.
      await discard(view.sandboxId);
      const [cur] = await db.select().from(practiceRuns).where(eq(practiceRuns.id, runId));
      return { runId, state: cur?.status ?? 'stopped', queuePosition: null };
    }
    return { runId, state, queuePosition: view.queuePosition };
  }

  /**
   * Writes a just-created sandbox onto its run, only if the run is still in the state the create
   * left it in (`claimed`, no sandbox). False: a stop (or anything else) changed it meanwhile.
   */
  async function attachSandbox(
    runId: string,
    claimed: RunState,
    view: SandboxView,
  ): Promise<boolean> {
    const state = runStatusOf(view);
    const updated = await db
      .update(practiceRuns)
      .set({
        sandboxId: view.sandboxId,
        status: state,
        endedAt: isActive(state) ? null : new Date(now()),
      })
      .where(
        and(
          eq(practiceRuns.id, runId),
          eq(practiceRuns.status, claimed),
          sql`${practiceRuns.sandboxId} is null`,
        ),
      )
      .returning({ id: practiceRuns.id });
    return updated.length > 0;
  }

  /** Removes a sandbox no run owns any more; failures are logged (idle / TTL end it anyway). */
  async function discard(sandboxId: string): Promise<void> {
    try {
      await client().remove(sandboxId, 'stopped_by_user');
    } catch (err) {
      deps.log?.warn({ err, sandboxId }, 'orphaned sandbox could not be removed');
    }
  }

  /**
   * The run behind the user's active sandbox, for a `run_exists` that came from sandboxd: an
   * active run in `practice_runs` other than `exceptRunId`, else the `run_id` of the user's
   * queued…ready row in `sandboxes` if it is one of their runs.
   */
  async function activeRunIdOf(userId: string, exceptRunId: string): Promise<string | null> {
    const [run] = await db
      .select({ id: practiceRuns.id })
      .from(practiceRuns)
      .where(
        and(
          eq(practiceRuns.userId, userId),
          inArray(practiceRuns.status, [...ACTIVE]),
          ne(practiceRuns.id, exceptRunId),
        ),
      );
    if (run) return run.id;
    const [sbx] = await db
      .select({ runId: practiceRuns.id })
      .from(sandboxes)
      .innerJoin(practiceRuns, eq(practiceRuns.id, sandboxes.runId))
      .where(
        and(
          eq(sandboxes.userId, userId),
          inArray(sandboxes.state, ['queued', 'starting', 'ready']),
          eq(practiceRuns.userId, userId),
          ne(practiceRuns.id, exceptRunId),
        ),
      );
    return sbx?.runId ?? null;
  }

  /** `GET /api/runs/:runId`: syncs an unfinished run, then the screen's whole state. */
  async function getRun(user: RunUser, runId: string): Promise<RunDto> {
    const { row, view } = await sync.syncRun(await loadRun(user, runId), false);
    const store = deps.content.current();
    const manifest = store.practice(row.practiceId)?.manifest;
    const progress = await progressOf(db, user.id, row.practiceId);
    const hints = manifest?.hints ?? [];
    const revealed = Math.min(progress.hintsRevealed, hints.length);
    const live = LIVE.includes(row.status) && view?.state === 'ready';
    return {
      runId: row.id,
      practiceId: row.practiceId,
      state: row.status,
      stopReason: view?.stopReason ?? null,
      queuePosition: row.status === 'queued' ? (view?.queuePosition ?? null) : null,
      expiresAt: view?.expiresAt ?? null,
      hardDeadline: view?.hardDeadline ?? null,
      goals: (manifest?.goals ?? []).map((g) => ({
        id: g.id,
        passed: progress.goalsPassed.includes(g.id),
      })),
      hintsRevealed: revealed,
      hints: hints.slice(0, revealed),
      canExtend: live && view.canExtend,
      resetsLeft: Math.max(0, RUN_LIMITS.resetsPerRun - row.resets),
      usage: live ? view.usage : null,
    };
  }

  /** A run whose sandbox is up (`ready`, or `solved` within its last 2 minutes). */
  async function liveRun(user: RunUser, runId: string): Promise<RunRow & { sandboxId: string }> {
    const { row, view } = await sync.syncRun(await loadRun(user, runId), false);
    if (!LIVE.includes(row.status) || !row.sandboxId || view?.state !== 'ready') throw notReady();
    return row as RunRow & { sandboxId: string };
  }

  /** `POST /api/runs/:runId/terminal-ticket`: single-use, 30 s, for the run's current sandbox. */
  async function terminalTicket(user: RunUser, runId: string): Promise<TerminalTicketResponse> {
    client();
    const row = await liveRun(user, runId);
    const ticket = signTicket(
      {
        runId: row.id,
        userId: user.id,
        sandboxId: row.sandboxId,
        exp: now() + RUN_LIMITS.ticketTtlMs,
        jti: randomUUID(),
      },
      deps.ticketSecret,
    );
    // Relative (spec §5.1): same origin through Caddy; the client builds ws(s):// from location.
    return { ticket, url: `/ws/terminal?ticket=${encodeURIComponent(ticket)}` };
  }

  async function scheduleStopSolved(job: StopSolvedJob): Promise<void> {
    if (!deps.boss) return;
    try {
      await deps.boss.send(STOP_SOLVED_QUEUE, job, {
        startAfter: RUN_LIMITS.stopSolvedAfterSec,
        retryLimit: 3,
        retryDelay: 30,
      });
    } catch (err) {
      // The sandbox then ends by idle / TTL; the solve itself is already committed.
      deps.log?.error({ err, ...job }, 'stop-solved could not be queued');
    }
  }

  /**
   * `POST /api/runs/:runId/check` (1 per 5 s per user): every goal's script through
   * `exec-checks`; passed = exit 0 without timeout. Passed goals are added to
   * `practice_progress.goals_passed`. All passed on a `ready` run → solved in one transaction:
   * `practiceXp(reward, hints_revealed, first solve)`, streak (`grantReward` →
   * `registerActivity`), `applyXp(source 'practice')`, run `solved`; then `stop-solved` in
   * 120 s. A check of an already solved run reports the goals and awards nothing.
   */
  async function check(user: RunUser, runId: string): Promise<CheckResponse> {
    const sandboxd = client();
    const owned = await loadRun(user, runId);
    const at = now();
    enforce(deps.limiters.practiceCheck, user.id, at, 'one check per 5 seconds');
    const row = await liveRun(user, owned.id);
    const store = deps.content.current();
    const practice = practiceOf(store, row.practiceId);
    const manifest = practice.manifest;

    let results;
    try {
      results = await sandboxd.execChecks(row.sandboxId, {
        checks: manifest.goals.map((g) => ({
          goalId: g.id,
          // A missing script fails its goal rather than passing it.
          script: practice.files[g.check] ?? 'exit 1',
          timeoutSec: g.timeoutSec,
        })),
      });
    } catch (err) {
      if (err instanceof SandboxdError && (err.code === 'validation' || err.status === 404)) {
        throw notReady();
      }
      throw fromSandboxd(err);
    }
    const goals = manifest.goals.map((g) => {
      const r = results.find((x) => x.goalId === g.id);
      return { id: g.id, passed: !!r && r.exitCode === 0 && !r.timedOut, output: r?.output ?? '' };
    });
    const solved = goals.every((g) => g.passed);

    const outcome = await db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(practiceRuns)
        .where(eq(practiceRuns.id, row.id))
        .for('update');
      const progress = await progressOf(tx, user.id, row.practiceId, true);
      const goalsPassed = [
        ...new Set([...progress.goalsPassed, ...goals.filter((g) => g.passed).map((g) => g.id)]),
      ];
      if (!solved || cur?.status !== 'ready') {
        await tx
          .update(practiceProgress)
          .set({ goalsPassed })
          .where(
            and(
              eq(practiceProgress.userId, user.id),
              eq(practiceProgress.practiceId, row.practiceId),
            ),
          );
        return null;
      }

      const first = progress.firstSolvedAt === null;
      const xp = practiceXp(manifest.reward, progress.hintsRevealed, first);
      await tx
        .update(practiceProgress)
        .set({
          goalsPassed,
          solveCount: sql`${practiceProgress.solveCount} + 1`,
          xpAwarded: sql`${practiceProgress.xpAwarded} + ${xp}`,
          ...(first ? { firstSolvedAt: new Date(at) } : {}),
        })
        .where(
          and(
            eq(practiceProgress.userId, user.id),
            eq(practiceProgress.practiceId, row.practiceId),
          ),
        );
      await tx
        .update(practiceRuns)
        .set({ status: 'solved', endedAt: new Date(at) })
        .where(eq(practiceRuns.id, row.id));

      const [s] = await tx.select().from(streaks).where(eq(streaks.userId, user.id)).for('update');
      if (!s) throw new Error(`user ${user.id} has no streaks row`);
      const delta = grantReward({
        streak: { current: s.current, best: s.best, lastActivityDate: s.lastActivityDate },
        xpToday: await xpOnDay(tx, user.id, toDateKey(at, user.tz)),
        xp,
        today: toDateKey(at, user.tz),
      });
      await tx
        .update(streaks)
        .set({
          current: delta.streak.current,
          best: delta.streak.best,
          lastActivityDate: delta.streak.lastActivityDate,
        })
        .where(eq(streaks.userId, user.id));
      const { xpToday } = await applyXp(tx, user, {
        amount: xp,
        source: 'practice',
        refId: row.practiceId,
        now: at,
        store,
      });
      const summary: PracticeSummaryDto = {
        kind: 'practice',
        practiceId: row.practiceId,
        xpGained: xp,
        xpToday,
        dailyGoal: DAILY_GOAL,
        goalJustReached: delta.goalJustReached,
        streak: delta.streak.current,
        streakIncreased: delta.streakIncreased,
      };
      return { xp, summary };
    });

    if (outcome) await scheduleStopSolved({ runId: row.id, sandboxId: row.sandboxId });
    return {
      goals,
      solved,
      xpAwarded: outcome?.xp ?? 0,
      ...(outcome ? { summary: outcome.summary } : {}),
    };
  }

  /**
   * `POST /api/runs/:runId/hints` (10/min per user): opens the next hint of the practice.
   * `hints_revealed` lives in `practice_progress`, so it carries over to later runs.
   */
  async function revealHint(user: RunUser, runId: string): Promise<HintResponse> {
    const row = await loadRun(user, runId);
    enforce(deps.limiters.practiceHints, user.id, now(), 'too many hints, wait a minute');
    if (!isActive(row.status) && row.status !== 'solved') {
      throw new HttpError(409, 'validation', 'this run is over');
    }
    const hints = practiceOf(deps.content.current(), row.practiceId).manifest.hints;
    const [updated] = await db.transaction(async (tx) => {
      await progressOf(tx, user.id, row.practiceId);
      return tx
        .update(practiceProgress)
        .set({ hintsRevealed: sql`${practiceProgress.hintsRevealed} + 1` })
        .where(
          and(
            eq(practiceProgress.userId, user.id),
            eq(practiceProgress.practiceId, row.practiceId),
            sql`${practiceProgress.hintsRevealed} < ${hints.length}`,
          ),
        )
        .returning({ hintsRevealed: practiceProgress.hintsRevealed });
    });
    if (!updated) throw new HttpError(409, 'validation', 'every hint is already open');
    const n = updated.hintsRevealed;
    return { index: n - 1, text: hints[n - 1]!, hintsRevealed: n };
  }

  /** `POST /api/runs/:runId/extend` → sandboxd's +15 min, or `409 extend_not_allowed`. */
  async function extend(user: RunUser, runId: string): Promise<ExtendRunResponse> {
    const sandboxd = client();
    const { row, view } = await sync.syncRun(await loadRun(user, runId), false);
    if (!LIVE.includes(row.status) || !row.sandboxId || view?.state !== 'ready') {
      throw new HttpError(409, 'extend_not_allowed', 'the sandbox cannot be extended now');
    }
    try {
      return await sandboxd.extend(row.sandboxId);
    } catch (err) {
      throw fromSandboxd(err);
    }
  }

  /**
   * `POST /api/runs/:runId/reset` (≤ 3 per run, `409 reset_limit` after): the sandbox is
   * removed (`reset`) and created again under the same run. The reset is claimed in the row lock
   * (`starting`, `sandbox_id = null`), so a second reset meanwhile gets `409 validation`; the
   * new sandbox is attached, or a refused re-create fails the run, only while that claim holds. A
   * stop in between wins: the new sandbox is removed and the reset answers `409 validation`.
   */
  async function reset(user: RunUser, runId: string): Promise<ResetRunResponse> {
    const sandboxd = client();
    const { row } = await sync.syncRun(await loadRun(user, runId), false);
    const practice = practiceOf(deps.content.current(), row.practiceId);
    const old = await db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(practiceRuns)
        .where(eq(practiceRuns.id, row.id))
        .for('update');
      if (!cur || !isActive(cur.status)) throw new HttpError(409, 'validation', 'this run is over');
      if (cur.resets >= RUN_LIMITS.resetsPerRun) {
        throw new HttpError(409, 'reset_limit', 'this run has been reset 3 times already');
      }
      // No sandbox: another reset (or the run's first create) is in flight.
      if (!cur.sandboxId) throw new HttpError(409, 'validation', 'a reset is already in progress');
      // The claim: `starting` without a sandbox until this reset attaches the new one.
      await tx
        .update(practiceRuns)
        .set({ resets: cur.resets + 1, status: 'starting', sandboxId: null })
        .where(eq(practiceRuns.id, cur.id));
      return cur.sandboxId;
    });

    /** Fails the run only while this reset still holds its claim (a stop wins). */
    const fail = async (err: unknown): Promise<never> => {
      await db
        .update(practiceRuns)
        .set({ status: 'failed', endedAt: new Date(now()) })
        .where(
          and(
            eq(practiceRuns.id, row.id),
            eq(practiceRuns.status, 'starting'),
            sql`${practiceRuns.sandboxId} is null`,
          ),
        );
      throw fromSandboxd(err);
    };
    try {
      await sandboxd.remove(old, 'reset');
    } catch (err) {
      if (!(err instanceof SandboxdError && err.status === 404)) await fail(err);
    }
    let view: SandboxView;
    try {
      view = await sandboxd.create(sandboxBody(row.id, user.id, practice));
    } catch (err) {
      return fail(err);
    }
    if (!(await attachSandbox(row.id, 'starting', view))) {
      await discard(view.sandboxId);
      throw new HttpError(409, 'validation', 'this run is over');
    }
    return { state: 'starting' };
  }

  /** `POST /api/runs/:runId/stop`: removes the sandbox (`stopped_by_user`); `solved` stays. */
  async function stop(user: RunUser, runId: string): Promise<void> {
    const sandboxd = client();
    const row = await loadRun(user, runId);
    const reason: WsCloseReason = 'stopped_by_user';
    if (row.sandboxId && (isActive(row.status) || row.status === 'solved')) {
      try {
        await sandboxd.remove(row.sandboxId, reason);
      } catch (err) {
        if (!(err instanceof SandboxdError && err.status === 404)) throw fromSandboxd(err);
      }
    }
    await db
      .update(practiceRuns)
      .set({ status: 'stopped', endedAt: new Date(now()) })
      .where(and(eq(practiceRuns.id, row.id), inArray(practiceRuns.status, [...ACTIVE])));
  }

  return { createRun, getRun, terminalTicket, check, revealHint, extend, reset, stop, sync };
}

export type RunService = ReturnType<typeof createRunService>;
