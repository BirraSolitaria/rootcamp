// Client of the sandboxd internal API (spec §5.3; network `rc-internal`, bearer INTERNAL_TOKEN).
// `createHttpSandboxdClient` talks to the real service; `createFakeSandboxdClient` keeps the same
// contract in memory for the api tests (§10.2: "sandboxd заменён фейком с тем же контрактом").
import { randomUUID } from 'node:crypto';
import {
  ExecChecksResponse,
  ExtendSandboxResponse,
  MetricsDto,
  SandboxView,
  type CreateSandboxBody,
  type ExecChecksBody,
  type ExecCheckResult,
  type SandboxState,
  type WsCloseReason,
} from '@rootcamp/api-contract';

export interface SandboxdClient {
  /** `POST /internal/sandboxes` → the new sandbox (`queued`). */
  create(body: CreateSandboxBody): Promise<SandboxView>;
  /**
   * `GET /internal/sandboxes/:id`. `passive` (background sync) does not count as activity, so
   * it never keeps an idle sandbox alive.
   */
  get(id: string, opts?: { passive?: boolean }): Promise<SandboxView>;
  /** `POST /internal/sandboxes/:id/exec-checks` (HTTP timeout 45 s). */
  execChecks(id: string, body: ExecChecksBody): Promise<ExecCheckResult[]>;
  /** `POST /internal/sandboxes/:id/extend`; `409 extend_not_allowed` otherwise. */
  extend(id: string): Promise<{ expiresAt: string }>;
  /** `DELETE /internal/sandboxes/:id`; resolves once the container is gone (idempotent). */
  remove(id: string, reason: WsCloseReason): Promise<void>;
  /** `GET /internal/metrics`. */
  metrics(): Promise<MetricsDto>;
  /** `GET /internal/health` answered 200 (within 2 s). Never throws. */
  health(): Promise<boolean>;
}

/**
 * A failed sandboxd call. `status`/`code` are sandboxd's error answer (`queue_full`, `run_exists`,
 * `extend_not_allowed`, `validation`, `not_found`, …); `status: 503, code: 'unavailable'` means
 * no answer at all (connection refused, timeout, malformed body).
 */
export class SandboxdError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxdError';
  }
}

/** HTTP timeouts per call. `remove` waits for `docker stop -t 10` + `rm` (about 12 s at worst). */
export const SANDBOXD_TIMEOUTS_MS = {
  default: 15_000,
  remove: 30_000,
  /** §9 «Проверка зависла»: `timeout` inside exec plus an HTTP timeout of 45 s. */
  execChecks: 45_000,
  health: 2_000,
} as const;

export interface HttpSandboxdOpts {
  fetch?: typeof fetch;
}

/** Client of a real sandboxd at `baseUrl` (e.g. `http://sandboxd:3001`). */
export function createHttpSandboxdClient(
  baseUrl: string,
  token: string,
  opts: HttpSandboxdOpts = {},
): SandboxdClient {
  const doFetch = opts.fetch ?? fetch;
  const root = baseUrl.replace(/\/+$/, '');

  async function call(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${root}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SandboxdError(503, 'unavailable', `sandboxd ${method} ${path}: ${String(err)}`);
    }
    const text = await res.text().catch(() => '');
    let json: unknown = undefined;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw new SandboxdError(503, 'unavailable', `sandboxd ${path}: not JSON`);
      }
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      throw new SandboxdError(
        res.status,
        typeof e?.code === 'string' ? e.code : 'internal',
        typeof e?.message === 'string' ? e.message : `sandboxd ${method} ${path}: ${res.status}`,
      );
    }
    return json;
  }

  function parse<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, v: unknown) {
    const r = schema.safeParse(v);
    if (!r.success) throw new SandboxdError(503, 'unavailable', 'sandboxd: unexpected answer');
    return r.data as T;
  }

  const id = (s: string) => encodeURIComponent(s);
  const T = SANDBOXD_TIMEOUTS_MS;
  return {
    async create(body) {
      return parse(SandboxView, await call('POST', '/internal/sandboxes', body, T.default));
    },
    async get(sid, o) {
      const q = o?.passive ? '?passive=1' : '';
      return parse(
        SandboxView,
        await call('GET', `/internal/sandboxes/${id(sid)}${q}`, undefined, T.default),
      );
    },
    async execChecks(sid, body) {
      const path = `/internal/sandboxes/${id(sid)}/exec-checks`;
      return parse(ExecChecksResponse, await call('POST', path, body, T.execChecks));
    },
    async extend(sid) {
      const path = `/internal/sandboxes/${id(sid)}/extend`;
      return parse(ExtendSandboxResponse, await call('POST', path, undefined, T.default));
    },
    async remove(sid, reason) {
      await call('DELETE', `/internal/sandboxes/${id(sid)}`, { reason }, T.remove);
    },
    async metrics() {
      return parse(MetricsDto, await call('GET', '/internal/metrics', undefined, T.default));
    },
    async health() {
      try {
        await call('GET', '/internal/health', undefined, T.health);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fake (tests)

export interface FakeSandbox {
  body: CreateSandboxBody;
  view: SandboxView;
  removedWith: WsCloseReason | null;
}

export interface FakeCall {
  method: 'create' | 'get' | 'execChecks' | 'extend' | 'remove' | 'metrics';
  id?: string;
  arg?: unknown;
}

export interface FakeSandboxdClient extends SandboxdClient {
  /** Exit codes of the next `execChecks` calls, by goal position (missing → 0). */
  setGoalExitCodes(codes: number[]): void;
  /**
   * Moves a sandbox to `state` (sandboxd's own transitions: admit, ready, GC stops, failures).
   * `ready` fills `readyAt`/`expiresAt`/`hardDeadline` from the fake's clock.
   */
  setState(sandboxId: string, state: SandboxState, stopReason?: string | null): void;
  /** Patches a sandbox's view (e.g. `canExtend`, `queuePosition`). */
  patch(sandboxId: string, view: Partial<SandboxView>): void;
  /** Makes `create` fail with this sandboxd error (status, code) until cleared with null. */
  failCreate(err: { status: number; code: string } | null): void;
  setHealthy(ok: boolean): void;
  /**
   * Makes the next `create` calls wait (after being recorded in `calls`) until the returned
   * function is called: lets a test land a request while a create is in flight.
   */
  holdCreates(): () => void;
  readonly sandboxes: Map<string, FakeSandbox>;
  readonly calls: FakeCall[];
  /** The newest sandbox created for `runId`. */
  latestFor(runId: string): FakeSandbox | undefined;
}

const ACTIVE: SandboxState[] = ['queued', 'starting', 'ready'];
const MIN = 60_000;

/** In-memory sandboxd with the internal contract: one active sandbox per user, idempotent DELETE. */
export function createFakeSandboxdClient(now: () => number = Date.now): FakeSandboxdClient {
  const sandboxes = new Map<string, FakeSandbox>();
  const calls: FakeCall[] = [];
  let exitCodes: number[] = [];
  let createError: { status: number; code: string } | null = null;
  let healthy = true;
  let gate: Promise<void> | null = null;

  function find(id: string): FakeSandbox {
    const s = sandboxes.get(id);
    if (!s) throw new SandboxdError(404, 'not_found', 'sandbox not found');
    return s;
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const copy = (v: SandboxView): SandboxView => ({ ...v });

  function setState(id: string, state: SandboxState, stopReason: string | null = null): void {
    const s = find(id);
    const v = s.view;
    v.state = state;
    v.stopReason = stopReason;
    v.queuePosition = state === 'queued' ? (v.queuePosition ?? 1) : null;
    if (state === 'ready') {
      const t = now();
      v.readyAt = iso(t);
      v.expiresAt = iso(t + s.body.ttlMin * MIN);
      v.hardDeadline = iso(t + 90 * MIN);
      v.usage = { cpuPct: 1, memMb: 64, memLimitMb: 512 };
    } else {
      v.usage = null;
      v.canExtend = false;
    }
  }

  return {
    sandboxes,
    calls,
    setGoalExitCodes(codes) {
      exitCodes = [...codes];
    },
    setState,
    patch(id, view) {
      Object.assign(find(id).view, view);
    },
    failCreate(err) {
      createError = err;
    },
    setHealthy(ok) {
      healthy = ok;
    },
    holdCreates() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    latestFor(runId) {
      let last: FakeSandbox | undefined;
      for (const s of sandboxes.values()) if (s.body.runId === runId) last = s;
      return last;
    },
    async create(body) {
      calls.push({ method: 'create', arg: body });
      if (gate) await gate;
      if (createError) throw new SandboxdError(createError.status, createError.code, 'fake');
      for (const s of sandboxes.values()) {
        if (body.userId && s.body.userId === body.userId && ACTIVE.includes(s.view.state)) {
          throw new SandboxdError(409, 'run_exists', 'user already has an active sandbox');
        }
      }
      const view: SandboxView = {
        sandboxId: randomUUID(),
        state: 'queued',
        stopReason: null,
        queuePosition: 1,
        expiresAt: null,
        hardDeadline: null,
        readyAt: null,
        canExtend: false,
        usage: null,
      };
      sandboxes.set(view.sandboxId, { body, view, removedWith: null });
      return copy(view);
    },
    async get(id, o) {
      calls.push({ method: 'get', id, arg: o });
      return copy(find(id).view);
    },
    async execChecks(id, body) {
      calls.push({ method: 'execChecks', id, arg: body });
      const s = find(id);
      if (s.view.state !== 'ready') throw new SandboxdError(409, 'validation', 'not ready');
      return body.checks.map((c, i) => {
        const exitCode = exitCodes[i] ?? 0;
        return {
          goalId: c.goalId,
          exitCode,
          output: exitCode === 0 ? '' : `goal ${c.goalId} failed`,
          timedOut: false,
        };
      });
    },
    async extend(id) {
      calls.push({ method: 'extend', id });
      const v = find(id).view;
      if (v.state !== 'ready' || !v.canExtend || !v.expiresAt || !v.hardDeadline) {
        throw new SandboxdError(409, 'extend_not_allowed', 'extend not allowed');
      }
      const next = Math.min(Date.parse(v.expiresAt) + 15 * MIN, Date.parse(v.hardDeadline));
      v.expiresAt = iso(next);
      v.canExtend = false;
      return { expiresAt: v.expiresAt };
    },
    async remove(id, reason) {
      calls.push({ method: 'remove', id, arg: reason });
      const s = find(id);
      if (s.view.state === 'stopped' || s.view.state === 'failed') return;
      s.removedWith = reason;
      setState(id, 'stopped', reason);
    },
    async metrics() {
      calls.push({ method: 'metrics' });
      return {
        at: null,
        host: { cpuPct: 0, memUsedMb: 0, memTotalMb: 0, diskUsedGb: 0, diskTotalGb: 0 },
        sandboxes: [],
        history: [],
      };
    },
    async health() {
      return healthy;
    },
  };
}
