// Terminal WebSocket (spec §5.2): `GET /ws/terminal?ticket=…` bridges the browser's xterm.js to
// tmux session `main` inside the user's sandbox (driver.execTty). Each connection is its own
// tmux client; closing the socket detaches only that client, so the session (and its history)
// survives for the next connection.
import websocket from '@fastify/websocket';
import {
  ClientCtl,
  WS_CLOSE_SILENT,
  WS_CLOSE_TOO_MANY,
  WS_CLOSE_UNAUTHORIZED,
  closeCodeFor,
  type ServerCtl,
  type WsCloseReason,
} from '@rootcamp/api-contract';
import { verifyTicket, type TicketPayload } from '@rootcamp/api-contract/ticket';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { TtyHandle } from './driver/types.js';
import type { Lifecycle, SandboxRow } from './lifecycle.js';

// ---- limits (spec §5.2, plan's global WS constraints) --------------------------------------

/** Binary input frames above this are dropped (the connection stays open). */
export const MAX_INPUT_BYTES = 4096;
/** Frames above this are refused by `ws` itself (close 1009): a hard cap on memory per frame. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_CONNECTIONS_PER_SANDBOX = 2;
/** Seen `jti`s are remembered this long (tickets live 30 s). */
export const JTI_TTL_MS = 2 * 60_000;
/** Output is coalesced for at most this long… */
export const FLUSH_MS = 16;
/** …or until this much is pending (and no send is larger). */
export const FLUSH_BYTES = 32 * 1024;
/** Output rate limit, bytes per second. */
export const OUTPUT_RATE = 1024 * 1024;
/** Token bucket capacity (the largest burst after a quiet period). */
export const OUTPUT_BURST = 128 * 1024;
/** Above this many unsent bytes on the socket (slow client), the exec stream is paused too. */
export const SOCKET_HIGH_WATER = 1024 * 1024;
/** No client frame for this long → close 4100. */
export const SILENCE_MS = 60_000;
/** `{t:'expiring'}` at these many seconds before `expires_at`. */
export const EXPIRING_MARKS_SEC = [300, 60] as const;
/** In-process throttle of `lifecycle.touch` per sandbox (it also throttles in SQL). */
export const TOUCH_EVERY_MS = 30_000;

// ---- pure parts ----------------------------------------------------------------------------

/** Single-use ticket ids: `use()` is true the first time, false for a replay within the TTL. */
export class JtiCache {
  private readonly seen = new Map<string, number>();
  private lastSweep = 0;

  constructor(private readonly ttlMs = JTI_TTL_MS) {}

  use(jti: string, now: number): boolean {
    this.sweep(now);
    const until = this.seen.get(jti);
    if (until !== undefined && until > now) return false;
    this.seen.set(jti, now + this.ttlMs);
    return true;
  }

  /** Forgets expired ids; runs at most every 10 s from `use()`, so the map stays small. */
  sweep(now: number, force = false): void {
    if (!force && now - this.lastSweep < 10_000) return;
    this.lastSweep = now;
    for (const [jti, until] of this.seen) if (until <= now) this.seen.delete(jti);
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Token bucket: `take(n)` spends (may go negative); `waitMs()` says when it is ≥ 0 again. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly rate = OUTPUT_RATE,
    private readonly burst = OUTPUT_BURST,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.at = now;
  }

  private refill(now: number): void {
    if (now > this.at) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) * this.rate) / 1000);
      this.at = now;
    }
  }

  /** Spends `n` bytes; true while the bucket is not empty (keep reading). */
  take(n: number, now: number): boolean {
    this.refill(now);
    this.tokens -= n;
    return this.tokens > 0;
  }

  /** Milliseconds until the bucket is positive again (0 if it is). */
  waitMs(now: number): number {
    this.refill(now);
    return this.tokens > 0 ? 0 : Math.ceil(((1 - this.tokens) * 1000) / this.rate);
  }
}

/**
 * Coalesces TTY output: pending bytes go out as one frame after `flushMs`, or as soon as
 * `maxBytes` are pending; no frame is larger than `maxBytes`.
 */
export class OutputCoalescer {
  private chunks: Buffer[] = [];
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly send: (b: Buffer) => void,
    private readonly flushMs = FLUSH_MS,
    private readonly maxBytes = FLUSH_BYTES,
  ) {}

  push(b: Buffer): void {
    if (b.length === 0) return;
    this.chunks.push(b);
    this.pending += b.length;
    while (this.pending >= this.maxBytes) {
      const all = Buffer.concat(this.chunks, this.pending);
      this.send(all.subarray(0, this.maxBytes));
      const rest = all.subarray(this.maxBytes);
      this.chunks = rest.length ? [rest] : [];
      this.pending = rest.length;
    }
    if (this.pending === 0) this.cancel();
    else this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    this.cancel();
    if (this.pending === 0) return;
    const all = Buffer.concat(this.chunks, this.pending);
    this.chunks = [];
    this.pending = 0;
    this.send(all);
  }

  /** Drops pending output (the socket is gone). */
  discard(): void {
    this.cancel();
    this.chunks = [];
    this.pending = 0;
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export type ClientFrame =
  | { kind: 'input'; data: Buffer }
  | { kind: 'ctl'; ctl: ClientCtl }
  /** `oversize` is logged; `invalid` (bad JSON, unknown `t`, resize out of bounds) is ignored. */
  | { kind: 'drop'; why: 'oversize' | 'invalid'; bytes: number };

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Binary frames are input (≤ 4096 bytes); text frames are `ClientCtl` JSON. */
export function classifyFrame(
  raw: Buffer | ArrayBuffer | Buffer[],
  isBinary: boolean,
): ClientFrame {
  const data = toBuffer(raw);
  if (isBinary) {
    return data.length > MAX_INPUT_BYTES
      ? { kind: 'drop', why: 'oversize', bytes: data.length }
      : { kind: 'input', data };
  }
  let json: unknown;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch {
    return { kind: 'drop', why: 'invalid', bytes: data.length };
  }
  const r = ClientCtl.safeParse(json);
  return r.success
    ? { kind: 'ctl', ctl: r.data }
    : { kind: 'drop', why: 'invalid', bytes: data.length };
}

/**
 * When to send `{t:'expiring'}` for an `expires_at`: one timer per mark still ahead; if a mark
 * has already passed (a connection opened with less than 5 min left), one frame right away.
 */
export function expiringPlan(
  expiresAtMs: number,
  now: number,
): { immediate: number | null; marks: { inMs: number; secondsLeft: number }[] } {
  const leftMs = expiresAtMs - now;
  if (leftMs <= 0) return { immediate: null, marks: [] };
  const marks = EXPIRING_MARKS_SEC.filter((s) => leftMs > s * 1000).map((s) => ({
    inMs: leftMs - s * 1000,
    secondsLeft: s,
  }));
  const immediate =
    leftMs <= EXPIRING_MARKS_SEC[0] * 1000 ? Math.max(0, Math.round(leftMs / 1000)) : null;
  return { immediate, marks };
}

/** Why a ticket does not open a terminal (logged; the client only sees 4401). */
export function ticketRefusal(
  t: TicketPayload,
  row: Pick<SandboxRow, 'state' | 'userId' | 'runId' | 'containerId'> | undefined,
): string | null {
  if (!row) return 'no such sandbox';
  if (row.state !== 'ready') return `sandbox is ${row.state}`;
  if (row.userId === null || row.userId !== t.userId) return 'sandbox of another user';
  if (row.runId !== t.runId) return 'sandbox of another run';
  if (!row.containerId) return 'sandbox has no container';
  return null;
}

// ---- connections ---------------------------------------------------------------------------

interface Conn {
  sandboxId: string;
  /** `{t:'closed'}` + close code; idempotent. */
  closeWith(reason: WsCloseReason): void;
  extended(expiresAt: Date): void;
}

/** Open (and opening) terminal connections per sandbox; the GC reads `count` for idleness. */
export class TerminalRegistry {
  private readonly bySandbox = new Map<string, Set<Conn>>();

  constructor(readonly maxPerSandbox = MAX_CONNECTIONS_PER_SANDBOX) {}

  count(sandboxId: string): number {
    return this.bySandbox.get(sandboxId)?.size ?? 0;
  }

  /** Adds `c` unless the sandbox is full; synchronous, so check-and-add cannot race. */
  tryAdd(c: Conn): boolean {
    let set = this.bySandbox.get(c.sandboxId);
    if (!set) {
      set = new Set();
      this.bySandbox.set(c.sandboxId, set);
    }
    if (set.size >= this.maxPerSandbox) return false;
    set.add(c);
    return true;
  }

  remove(c: Conn): void {
    const set = this.bySandbox.get(c.sandboxId);
    if (!set) return;
    set.delete(c);
    if (set.size === 0) this.bySandbox.delete(c.sandboxId);
  }

  of(sandboxId: string): Conn[] {
    return [...(this.bySandbox.get(sandboxId) ?? [])];
  }
}

export interface TerminalOptions {
  lifecycle: Pick<Lifecycle, 'get' | 'touch' | 'onSandboxClosed' | 'onSandboxExtended'>;
  driver: { execTty(containerId: string): Promise<TtyHandle> };
  /** `TICKET_SECRET`; must be non-empty (config enforces ≥ 16 chars). */
  secret: string;
  registry?: TerminalRegistry;
  silenceMs?: number;
  now?: () => number;
}

const send = (ws: WebSocket, msg: ServerCtl) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

/**
 * Registers `@fastify/websocket` and `GET /ws/terminal`. Close codes: 4401 before `ready`
 * (bad/expired/reused ticket, sandbox not `ready` for this user and run), 4409 for a third
 * connection, 4100 after 60 s without a client frame, `closeCodeFor(reason)` after
 * `{t:'closed', reason}`, 1000 when the tmux client ended on its own (e.g. `exit` in the last
 * shell; reconnecting opens a fresh session), 1011 when the exec could not be started.
 */
export async function terminalRoutes(app: FastifyInstance, opts: TerminalOptions): Promise<void> {
  if (!opts.secret) throw new Error('terminal: empty ticket secret');
  const now = opts.now ?? Date.now;
  const registry = opts.registry ?? new TerminalRegistry();
  const silenceMs = opts.silenceMs ?? SILENCE_MS;
  const jtis = new JtiCache();
  const lastTouch = new Map<string, number>();

  const offClosed = opts.lifecycle.onSandboxClosed((id, reason) => {
    lastTouch.delete(id);
    for (const c of registry.of(id)) c.closeWith(reason);
  });
  const offExtended = opts.lifecycle.onSandboxExtended((id, at) => {
    for (const c of registry.of(id)) c.extended(at);
  });
  app.addHook('onClose', async () => {
    offClosed();
    offExtended();
  });

  const touch = (sandboxId: string, log: FastifyBaseLogger) => {
    const t = now();
    if (t - (lastTouch.get(sandboxId) ?? -Infinity) < TOUCH_EVERY_MS) return;
    lastTouch.set(sandboxId, t);
    opts.lifecycle.touch(sandboxId).catch((err: unknown) => log.warn({ err }, 'touch failed'));
  };

  await app.register(websocket, { options: { maxPayload: MAX_PAYLOAD_BYTES } });

  app.get<{ Querystring: { ticket?: string } }>(
    '/ws/terminal',
    // The URL carries the ticket: keep it out of the per-request info logs.
    { websocket: true, logLevel: 'warn' },
    (ws, req) => {
      const log = req.log;
      let ended = false;
      let tty: TtyHandle | undefined;
      let ttyClosed = false;
      let conn: Conn | undefined;
      let silence: ReturnType<typeof setTimeout> | undefined;
      let resumeTimer: ReturnType<typeof setTimeout> | undefined;
      let expiring: ReturnType<typeof setTimeout>[] = [];
      let paused = false;
      const early: { data: Buffer; isBinary: boolean }[] = [];
      const bucket = new TokenBucket(OUTPUT_RATE, OUTPUT_BURST, now());
      const out = new OutputCoalescer((b) => {
        if (ws.readyState === ws.OPEN) ws.send(b, { binary: true });
      });

      const closeTty = () => {
        // Guard: a second close() would start a second detach exec.
        if (!tty || ttyClosed) return;
        ttyClosed = true;
        tty.close();
      };
      const cleanup = () => {
        if (ended) return;
        ended = true;
        if (silence) clearTimeout(silence);
        if (resumeTimer) clearTimeout(resumeTimer);
        for (const t of expiring) clearTimeout(t);
        expiring = [];
        out.discard();
        if (conn) registry.remove(conn);
        closeTty();
      };
      const finish = (code: number, why: string) => {
        if (!ended) out.flush();
        cleanup();
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, why);
      };
      const armSilence = () => {
        if (silence) clearTimeout(silence);
        silence = setTimeout(() => finish(WS_CLOSE_SILENT, 'silent'), silenceMs);
      };
      const armExpiring = (expiresAt: Date | null) => {
        for (const t of expiring) clearTimeout(t);
        expiring = [];
        if (!expiresAt) return;
        const plan = expiringPlan(expiresAt.getTime(), now());
        if (plan.immediate !== null) send(ws, { t: 'expiring', secondsLeft: plan.immediate });
        for (const m of plan.marks) {
          expiring.push(
            setTimeout(() => send(ws, { t: 'expiring', secondsLeft: m.secondsLeft }), m.inMs),
          );
        }
      };
      // Resume the exec stream once the bucket refilled and the socket drained; only ever
      // called after we paused it (an early resume() would drop output, see TtyHandle).
      const scheduleResume = () => {
        if (resumeTimer || ended) return;
        const wait = Math.max(
          bucket.waitMs(now()),
          ws.bufferedAmount > SOCKET_HIGH_WATER ? 50 : 0,
          1,
        );
        resumeTimer = setTimeout(() => {
          resumeTimer = undefined;
          if (ended) return;
          if (bucket.waitMs(now()) > 0 || ws.bufferedAmount > SOCKET_HIGH_WATER) {
            scheduleResume();
            return;
          }
          paused = false;
          tty?.resume();
        }, wait);
      };

      const handle = (data: Buffer, isBinary: boolean) => {
        const f = classifyFrame(data, isBinary);
        if (f.kind === 'drop') {
          if (f.why === 'oversize') log.warn({ bytes: f.bytes }, 'terminal input frame dropped');
          return;
        }
        if (f.kind === 'input') {
          tty!.write(f.data);
          touch(conn!.sandboxId, log);
          return;
        }
        if (f.ctl.t === 'ping') send(ws, { t: 'pong' });
        else if (f.ctl.t === 'resize') {
          tty!.resize(f.ctl.cols, f.ctl.rows).catch((err: unknown) => {
            log.warn({ err }, 'terminal resize failed');
          });
        }
      };

      // Handlers go on synchronously: frames arriving during the async setup are queued.
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (ended) return;
        armSilence();
        if (tty) handle(data, isBinary);
        else if (early.length < 16) early.push({ data, isBinary });
      });
      ws.on('ping', () => {
        if (!ended) armSilence();
      });
      ws.on('close', cleanup);
      ws.on('error', (err) => {
        log.warn({ err }, 'terminal socket error');
        cleanup();
      });
      armSilence();

      const refuse = (why: string) => {
        // warn: the route's logLevel hides info; never log the ticket or the URL.
        log.warn({ why }, 'terminal refused');
        finish(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      };

      let ticket: TicketPayload;
      try {
        ticket = verifyTicket(req.query.ticket ?? '', opts.secret, now());
      } catch (err) {
        refuse(`ticket: ${(err as Error).message}`);
        return;
      }
      if (!jtis.use(ticket.jti, now())) {
        refuse('ticket reused');
        return;
      }

      void (async () => {
        let row: SandboxRow | undefined;
        try {
          row = await opts.lifecycle.get(ticket.sandboxId);
        } catch (err) {
          log.error({ err }, 'terminal: sandbox lookup failed');
          finish(1011, 'internal');
          return;
        }
        if (ended) return;
        const why = ticketRefusal(ticket, row);
        if (why) {
          refuse(why);
          return;
        }
        // The deadline to arm at `ready`: an `extended` arriving while the exec starts wins
        // over the row read here.
        let expiresAt = row!.expiresAt;
        let readySent = false;
        let pendingExtended: Date | undefined;
        conn = {
          sandboxId: ticket.sandboxId,
          closeWith: (reason) => {
            if (ended) return;
            out.flush();
            send(ws, { t: 'closed', reason });
            finish(closeCodeFor(reason), reason);
          },
          extended: (at) => {
            if (ended) return;
            expiresAt = at;
            if (!readySent) {
              pendingExtended = at;
              return;
            }
            send(ws, { t: 'extended', expiresAt: at.toISOString() });
            armExpiring(at);
          },
        };
        if (!registry.tryAdd(conn)) {
          conn = undefined;
          log.warn({ sandboxId: ticket.sandboxId }, 'terminal refused: too many connections');
          finish(WS_CLOSE_TOO_MANY, 'too many connections');
          return;
        }

        // Re-check now that `closed` events reach this connection. A stop commits `stopping`
        // before it emits `closed`, so a stop racing the first read is either caught by the
        // registered connection (closeWith) or visible in this read.
        let again: SandboxRow | undefined;
        try {
          again = await opts.lifecycle.get(ticket.sandboxId);
        } catch (err) {
          log.error({ err }, 'terminal: sandbox lookup failed');
          finish(1011, 'internal');
          return;
        }
        if (ended) return;
        const whyNow = ticketRefusal(ticket, again);
        if (whyNow || again!.containerId !== row!.containerId) {
          refuse(whyNow ?? 'sandbox container changed');
          return;
        }
        if (!pendingExtended) expiresAt = again!.expiresAt;

        let handle_: TtyHandle;
        try {
          handle_ = await opts.driver.execTty(row!.containerId!);
        } catch (err) {
          log.error({ err, sandboxId: ticket.sandboxId }, 'terminal: execTty failed');
          finish(1011, 'terminal unavailable');
          return;
        }
        tty = handle_;
        if (ended) {
          // The socket went away (or the sandbox closed) while the exec was starting.
          closeTty();
          return;
        }
        tty.onExit(() => {
          if (!ended) {
            ttyClosed = true;
            finish(1000, 'terminal ended');
          }
        });
        send(ws, { t: 'ready' });
        readySent = true;
        if (pendingExtended) send(ws, { t: 'extended', expiresAt: pendingExtended.toISOString() });
        armExpiring(expiresAt);
        tty.onData((chunk) => {
          if (ended) return;
          out.push(chunk);
          const ok = bucket.take(chunk.length, now());
          if ((!ok || ws.bufferedAmount > SOCKET_HIGH_WATER) && !paused) {
            paused = true;
            tty!.pause();
            scheduleResume();
          }
        });
        for (const f of early.splice(0)) handle(f.data, f.isBinary);
      })();
    },
  );
}
