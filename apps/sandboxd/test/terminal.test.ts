// Terminal WebSocket (spec §5.2). Three layers:
//  - the pure parts (jti cache, token bucket, output coalescer, frame rules, expiring plan);
//  - the protocol against a fake lifecycle and a fake TTY (runs anywhere);
//  - end to end against real PostgreSQL and a runc-dev sandbox with tmux (where Docker is
//    reachable: the VPS, R-M4a-1).
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ServerCtl, WsCloseReason } from '@rootcamp/api-contract';
import { signTicket, type TicketPayload } from '@rootcamp/api-contract/ticket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { TtyHandle } from '../src/driver/types.js';
import { Lifecycle, type SandboxRow } from '../src/lifecycle.js';
import {
  FLUSH_BYTES,
  JtiCache,
  OutputCoalescer,
  TerminalRegistry,
  TokenBucket,
  classifyFrame,
  expiringPlan,
  terminalRoutes,
} from '../src/terminal.js';
import {
  ScopedDriver,
  allRowIds,
  createBody,
  dockerAvailable,
  newUser,
  sleep,
  startPg,
  sweep,
  waitFor,
  type Pg,
} from './helpers/stack.js';

const SECRET = 'test-ticket-secret-0123456789abcdef';

// ---- a test client --------------------------------------------------------------------------

interface Client {
  ws: WebSocket;
  ctl: ServerCtl[];
  /** Binary frames received (sizes), for the coalescing checks. */
  frames: number[];
  out(): string;
  bytes(): number;
  closed: Promise<{ code: number; reason: string }>;
  waitCtl<T extends ServerCtl['t']>(t: T, ms?: number): Promise<Extract<ServerCtl, { t: T }>>;
  waitOut(re: RegExp, ms?: number): Promise<string>;
  sendCtl(msg: unknown): void;
}

function connect(base: string, ticket: string): Client {
  const ws = new WebSocket(`${base}/ws/terminal?ticket=${encodeURIComponent(ticket)}`);
  const ctl: ServerCtl[] = [];
  const frames: number[] = [];
  const chunks: Buffer[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  ws.on('error', () => {});
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      frames.push(data.length);
      chunks.push(data);
    } else ctl.push(JSON.parse(data.toString()) as ServerCtl);
  });
  const out = () => Buffer.concat(chunks).toString('utf8');
  return {
    ws,
    ctl,
    frames,
    out,
    bytes: () => chunks.reduce((n, c) => n + c.length, 0),
    closed,
    waitCtl: async (t, ms = 5_000) =>
      (await waitFor(`{t:'${t}'}`, async () => ctl.find((c) => c.t === t), ms)) as never,
    waitOut: (re, ms = 10_000) =>
      waitFor(`output ${re}`, async () => (re.test(out()) ? out() : undefined), ms),
    sendCtl: (msg) => ws.send(JSON.stringify(msg)),
  };
}

const ticketFor = (
  p: Partial<TicketPayload> & Pick<TicketPayload, 'sandboxId' | 'userId' | 'runId'>,
  secret = SECRET,
) => signTicket({ exp: Date.now() + 30_000, jti: randomUUID(), ...p }, secret);

// ---- pure parts -----------------------------------------------------------------------------

describe('JtiCache', () => {
  test('a jti is accepted once, refused for 2 min, then forgotten', () => {
    const c = new JtiCache();
    expect(c.use('a', 0)).toBe(true);
    expect(c.use('a', 1_000)).toBe(false);
    expect(c.use('a', 119_999)).toBe(false);
    expect(c.use('b', 1_000)).toBe(true);
    expect(c.use('a', 120_000)).toBe(true);
  });

  test('expired entries are swept', () => {
    const c = new JtiCache();
    for (let i = 0; i < 100; i++) c.use(`j${i}`, 0);
    expect(c.size).toBe(100);
    c.use('late', 200_000);
    expect(c.size).toBe(1);
  });
});

describe('TokenBucket', () => {
  test('1 MB/s: a burst drains the bucket, the wait is the refill time', () => {
    const b = new TokenBucket(1024 * 1024, 128 * 1024, 0);
    expect(b.take(64 * 1024, 0)).toBe(true);
    expect(b.take(64 * 1024, 0)).toBe(false);
    expect(b.waitMs(0)).toBe(1);
    expect(b.take(512 * 1024, 0)).toBe(false);
    // 512 KiB in debt at 1 MiB/s: about half a second.
    expect(b.waitMs(0)).toBe(501);
    expect(b.waitMs(250)).toBe(251);
    expect(b.waitMs(501)).toBe(0);
  });

  test('over time the rate holds at 1 MB/s', () => {
    const b = new TokenBucket(1024 * 1024, 128 * 1024, 0);
    let t = 0;
    let sent = 0;
    while (t < 10_000) {
      const w = b.waitMs(t);
      if (w > 0) t += w;
      b.take(16 * 1024, t);
      sent += 16 * 1024;
    }
    // 10 s × 1 MiB/s plus the initial burst.
    expect(sent).toBeLessThanOrEqual(10 * 1024 * 1024 + 256 * 1024);
    expect(sent).toBeGreaterThan(9.5 * 1024 * 1024);
  });
});

describe('OutputCoalescer', () => {
  afterEach(() => vi.useRealTimers());

  test('small chunks go out as one frame after 16 ms', () => {
    vi.useFakeTimers();
    const sent: Buffer[] = [];
    const c = new OutputCoalescer((b) => sent.push(Buffer.from(b)));
    for (let i = 0; i < 10; i++) c.push(Buffer.from('ab'));
    vi.advanceTimersByTime(15);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent.map((b) => b.toString())).toEqual(['ab'.repeat(10)]);
  });

  test('32 KB pending is sent at once; no frame exceeds 32 KB', () => {
    vi.useFakeTimers();
    const sent: Buffer[] = [];
    const c = new OutputCoalescer((b) => sent.push(Buffer.from(b)));
    c.push(Buffer.alloc(FLUSH_BYTES * 2 + 100, 1));
    expect(sent.map((b) => b.length)).toEqual([FLUSH_BYTES, FLUSH_BYTES]);
    vi.advanceTimersByTime(16);
    expect(sent.map((b) => b.length)).toEqual([FLUSH_BYTES, FLUSH_BYTES, 100]);
  });

  test('discard drops pending output', () => {
    vi.useFakeTimers();
    const sent: Buffer[] = [];
    const c = new OutputCoalescer((b) => sent.push(b));
    c.push(Buffer.from('x'));
    c.discard();
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(0);
  });
});

describe('classifyFrame', () => {
  test('binary input: exactly 4096 bytes is accepted, 4097 dropped', () => {
    expect(classifyFrame(Buffer.alloc(4096), true)).toMatchObject({ kind: 'input' });
    expect(classifyFrame(Buffer.alloc(4097), true)).toEqual({
      kind: 'drop',
      why: 'oversize',
      bytes: 4097,
    });
  });

  test('text frames are ClientCtl; bad JSON or bounds are ignored', () => {
    const text = (v: unknown) => classifyFrame(Buffer.from(JSON.stringify(v)), false);
    expect(text({ t: 'ping' })).toEqual({ kind: 'ctl', ctl: { t: 'ping' } });
    expect(text({ t: 'resize', cols: 120, rows: 40 })).toEqual({
      kind: 'ctl',
      ctl: { t: 'resize', cols: 120, rows: 40 },
    });
    expect(text({ t: 'resize', cols: 10, rows: 40 })).toMatchObject({
      kind: 'drop',
      why: 'invalid',
    });
    expect(text({ t: 'resize', cols: 120, rows: 201 })).toMatchObject({ kind: 'drop' });
    expect(text({ t: 'nope' })).toMatchObject({ kind: 'drop', why: 'invalid' });
    expect(classifyFrame(Buffer.from('{oops'), false)).toMatchObject({ kind: 'drop' });
  });
});

describe('expiringPlan', () => {
  test('marks at 300 s and 60 s before expires_at', () => {
    expect(expiringPlan(1_000_000, 1_000_000 - 600_000)).toEqual({
      immediate: null,
      marks: [
        { inMs: 300_000, secondsLeft: 300 },
        { inMs: 540_000, secondsLeft: 60 },
      ],
    });
  });

  test('under 5 min left: one frame now, then the 60 s mark', () => {
    expect(expiringPlan(200_000, 0)).toEqual({
      immediate: 200,
      marks: [{ inMs: 140_000, secondsLeft: 60 }],
    });
    expect(expiringPlan(30_000, 0)).toEqual({ immediate: 30, marks: [] });
    expect(expiringPlan(0, 0)).toEqual({ immediate: null, marks: [] });
  });
});

// ---- protocol, against fakes ----------------------------------------------------------------

class FakeTty implements TtyHandle {
  writes: Buffer[] = [];
  resizes: [number, number][] = [];
  closes = 0;
  pauses = 0;
  resumes = 0;
  private dataCb: ((b: Buffer) => void) | undefined;
  private exitCbs: (() => void)[] = [];
  write(b: Buffer) {
    this.writes.push(Buffer.from(b));
  }
  onData(cb: (b: Buffer) => void) {
    this.dataCb = cb;
  }
  async resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  close() {
    this.closes++;
    this.exit();
  }
  onExit(cb: () => void) {
    this.exitCbs.push(cb);
  }
  pause() {
    this.pauses++;
  }
  resume() {
    this.resumes++;
  }
  emit(b: Buffer | string) {
    this.dataCb?.(Buffer.from(b));
  }
  exit() {
    for (const cb of this.exitCbs.splice(0)) cb();
  }
}

describe('terminal protocol (fake lifecycle and TTY)', () => {
  const events = new EventEmitter();
  const rows = new Map<string, Partial<SandboxRow>>();
  const touches: string[] = [];
  const ttys: FakeTty[] = [];
  const registry = new TerminalRegistry();
  let app: FastifyInstance;
  let base = '';

  const lifecycle = {
    get: async (id: string) => rows.get(id) as SandboxRow | undefined,
    touch: async (id: string) => {
      touches.push(id);
    },
    onSandboxClosed: (cb: (id: string, r: WsCloseReason) => void) => {
      events.on('closed', cb);
      return () => events.off('closed', cb);
    },
    onSandboxExtended: (cb: (id: string, at: Date) => void) => {
      events.on('extended', cb);
      return () => events.off('extended', cb);
    },
  };

  /** A ready sandbox row; returns the ticket fields for it. */
  function sandbox(over: Partial<SandboxRow> = {}) {
    const p = { sandboxId: randomUUID(), userId: randomUUID(), runId: randomUUID() };
    rows.set(p.sandboxId, {
      id: p.sandboxId,
      userId: p.userId,
      runId: p.runId,
      state: 'ready',
      containerId: `c-${p.sandboxId}`,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      ...over,
    });
    return p;
  }

  const open = (p: Parameters<typeof ticketFor>[0], secret?: string) =>
    connect(base, ticketFor(p, secret));

  async function ready(p: Parameters<typeof ticketFor>[0]) {
    const c = open(p);
    await c.waitCtl('ready');
    return { c, tty: ttys.at(-1)! };
  }

  beforeAll(async () => {
    app = Fastify();
    await app.register(terminalRoutes, {
      lifecycle,
      driver: {
        execTty: async () => {
          const t = new FakeTty();
          ttys.push(t);
          return t;
        },
      },
      secret: SECRET,
      registry,
      silenceMs: 1_000,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  test('ready, input goes to the TTY, output comes back, ping → pong', async () => {
    const p = sandbox();
    const { c, tty } = await ready(p);
    expect(c.ctl[0]).toEqual({ t: 'ready' });
    c.ws.send(Buffer.from('echo hi\r'));
    await waitFor('write', async () => tty.writes.length > 0);
    expect(Buffer.concat(tty.writes).toString()).toBe('echo hi\r');
    tty.emit('hi\r\n');
    await c.waitOut(/hi/);
    c.sendCtl({ t: 'ping' });
    await c.waitCtl('pong');
    expect(registry.count(p.sandboxId)).toBe(1);
    c.ws.close();
    await c.closed;
    await waitFor('slot released', async () => registry.count(p.sandboxId) === 0);
    expect(tty.closes).toBe(1);
  });

  test.each([
    [
      'a bad signature',
      (p: ReturnType<typeof sandbox>) => ticketFor(p, 'another-secret-0123456789'),
    ],
    [
      'an expired ticket',
      (p: ReturnType<typeof sandbox>) => ticketFor({ ...p, exp: Date.now() - 1 }),
    ],
    ['another user', (p: ReturnType<typeof sandbox>) => ticketFor({ ...p, userId: randomUUID() })],
    ['another run', (p: ReturnType<typeof sandbox>) => ticketFor({ ...p, runId: randomUUID() })],
    [
      'an unknown sandbox',
      (p: ReturnType<typeof sandbox>) => ticketFor({ ...p, sandboxId: randomUUID() }),
    ],
    ['no ticket', () => ''],
  ])('%s → 4401 before ready', async (_name, make) => {
    const p = sandbox();
    const c = connect(base, make(p));
    expect((await c.closed).code).toBe(4401);
    expect(c.ctl).toEqual([]);
  });

  test('a sandbox that is not ready → 4401', async () => {
    const p = sandbox({ state: 'starting' });
    const c = open(p);
    expect((await c.closed).code).toBe(4401);
    expect(c.ctl).toEqual([]);
  });

  test('a reused ticket → 4401', async () => {
    const p = sandbox();
    const t = ticketFor(p);
    const a = connect(base, t);
    await a.waitCtl('ready');
    const b = connect(base, t);
    expect((await b.closed).code).toBe(4401);
    expect(b.ctl).toEqual([]);
    a.ws.close();
    await a.closed;
  });

  test('a third connection → 4409; a freed slot can be reused', async () => {
    const p = sandbox();
    const a = await ready(p);
    const b = await ready(p);
    const c = open(p);
    expect((await c.closed).code).toBe(4409);
    expect(c.ctl).toEqual([]);
    expect(registry.count(p.sandboxId)).toBe(2);
    a.c.ws.terminate();
    await waitFor('slot released', async () => registry.count(p.sandboxId) === 1);
    expect(a.tty.closes).toBe(1);
    const d = await ready(p);
    for (const x of [b.c, d.c]) x.ws.close();
    await Promise.all([b.c.closed, d.c.closed]);
  });

  test('resize: out of bounds ignored, valid passed to the TTY', async () => {
    const p = sandbox();
    const { c, tty } = await ready(p);
    c.sendCtl({ t: 'resize', cols: 10, rows: 40 });
    c.sendCtl({ t: 'resize', cols: 120, rows: 40 });
    await waitFor('resize', async () => tty.resizes.length > 0);
    expect(tty.resizes).toEqual([[120, 40]]);
    c.ws.close();
    await c.closed;
  });

  test('input: 4096 bytes accepted, 4097 dropped, the connection stays open', async () => {
    const p = sandbox();
    const { c, tty } = await ready(p);
    c.ws.send(Buffer.alloc(4096, 'a'));
    c.ws.send(Buffer.alloc(4097, 'b'));
    c.ws.send(Buffer.from('z'));
    c.sendCtl({ t: 'ping' });
    await c.waitCtl('pong');
    await waitFor('writes', async () => tty.writes.length === 2);
    expect(tty.writes.map((w) => w.length)).toEqual([4096, 1]);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
    await c.closed;
  });

  test('input touches last_activity_at at most once per 30 s', async () => {
    const p = sandbox();
    const { c } = await ready(p);
    c.ws.send(Buffer.from('a'));
    c.ws.send(Buffer.from('b'));
    c.sendCtl({ t: 'ping' });
    await c.waitCtl('pong');
    expect(touches.filter((t) => t === p.sandboxId)).toHaveLength(1);
    c.ws.close();
    await c.closed;
  });

  test('silence → 4100; frames keep the connection alive', async () => {
    const p = sandbox();
    const { c, tty } = await ready(p);
    for (let i = 0; i < 4; i++) {
      await sleep(400);
      c.sendCtl({ t: 'ping' });
    }
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect((await c.closed).code).toBe(4100);
    expect(tty.closes).toBe(1);
  });

  test('closed event → {t:closed} then code 4000 + index', async () => {
    const p = sandbox();
    const { c, tty } = await ready(p);
    events.emit('closed', p.sandboxId, 'stopped_by_user');
    const done = await c.closed;
    expect(c.ctl.at(-1)).toEqual({ t: 'closed', reason: 'stopped_by_user' });
    expect(done.code).toBe(4002);
    expect(tty.closes).toBe(1);
  });

  test('expiring at 300 s, extended re-arms the marks', async () => {
    const p = sandbox({ expiresAt: new Date(Date.now() + 300_400) });
    const { c } = await ready(p);
    expect(await c.waitCtl('expiring', 3_000)).toEqual({ t: 'expiring', secondsLeft: 300 });
    const at = new Date(Date.now() + 15 * 60_000);
    events.emit('extended', p.sandboxId, at);
    expect(await c.waitCtl('extended')).toEqual({ t: 'extended', expiresAt: at.toISOString() });
    c.ws.close();
    await c.closed;
    expect(c.ctl.filter((x) => x.t === 'expiring')).toHaveLength(1);
  });

  test('connecting with under 5 min left sends expiring at once', async () => {
    const p = sandbox({ expiresAt: new Date(Date.now() + 120_000) });
    const { c } = await ready(p);
    expect(await c.waitCtl('expiring')).toEqual({ t: 'expiring', secondsLeft: 120 });
    c.ws.close();
    await c.closed;
  });

  test('output is coalesced: small chunks in few frames, none over 32 KB', async () => {
    const p = sandbox();
    const { c, tty } = await ready(p);
    for (let i = 0; i < 200; i++) tty.emit('x');
    await waitFor('200 bytes', async () => c.bytes() === 200);
    expect(c.frames.length).toBeLessThanOrEqual(2);
    tty.emit(Buffer.alloc(100 * 1024, 'y'));
    await waitFor('all bytes', async () => c.bytes() === 200 + 100 * 1024, 5_000);
    expect(Math.max(...c.frames)).toBeLessThanOrEqual(32 * 1024);
    c.ws.close();
    await c.closed;
  });

  test('the token bucket pauses the exec stream and resumes it', async () => {
    const p = sandbox();
    const { c, tty } = await ready(p);
    tty.emit(Buffer.alloc(300 * 1024, 'z'));
    expect(tty.pauses).toBe(1);
    expect(tty.resumes).toBe(0);
    await waitFor('resumed', async () => tty.resumes === 1, 2_000);
    await waitFor('all bytes', async () => c.bytes() === 300 * 1024);
    c.ws.close();
    await c.closed;
  });

  test('the TTY ending on its own closes the socket with 1000', async () => {
    const p = sandbox();
    const { c, tty } = await ready(p);
    tty.exit();
    expect((await c.closed).code).toBe(1000);
    expect(tty.closes).toBe(0);
    expect(registry.count(p.sandboxId)).toBe(0);
  });
});

// ---- end to end (runc-dev, real Postgres) ---------------------------------------------------

/** Records `resize` calls of every TTY it opens. */
class SpyDriver extends ScopedDriver {
  readonly resizes: [number, number][] = [];
  override async execTty(id: string): Promise<TtyHandle> {
    const t = await super.execTty(id);
    const resize = t.resize.bind(t);
    t.resize = async (cols, rows) => {
      this.resizes.push([cols, rows]);
      await resize(cols, rows);
    };
    return t;
  }
}

describe.runIf(dockerAvailable)('terminal websocket (runc-dev, real Postgres)', () => {
  let s: Pg;
  let app: FastifyInstance;
  let lifecycle: Lifecycle;
  let base = '';
  const driver = new SpyDriver();
  const TOKEN = 'test-internal-token-0123456789';
  let ids = { sandboxId: '', userId: '', runId: '' };
  let containerId = '';
  const open: Client[] = [];

  const client = () => {
    const c = connect(base, ticketFor(ids));
    open.push(c);
    return c;
  };
  async function closeAll() {
    for (const c of open.splice(0)) {
      c.ws.close();
      await c.closed;
    }
    await waitFor('no connections', async () => app.terminals.count(ids.sandboxId) === 0);
  }
  /** Number of tmux clients attached in the sandbox. */
  async function tmux(cmd: string) {
    return (await driver.exec(containerId, cmd, { timeoutSec: 10 })).output;
  }

  beforeAll(async () => {
    s = await startPg();
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused',
      INTERNAL_TOKEN: TOKEN,
      TICKET_SECRET: SECRET,
      SANDBOX_DRIVER: 'runc-dev',
      NODE_ENV: 'test',
    });
    await driver.ensureNetwork();
    lifecycle = new Lifecycle({
      db: s.h.db,
      driver,
      budget: config.budget,
      queueMax: config.queueMax,
      diskFreeGb: async () => 100,
    });
    app = await buildApp({ config, driver, db: s.h.db, lifecycle });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const userId = await newUser(s.h.db);
    const body = createBody({ userId, title: 'terminal test' });
    const r = await app.inject({
      method: 'POST',
      url: '/internal/sandboxes',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: body,
    });
    expect(r.statusCode).toBe(201);
    const sandboxId = (r.json() as { sandboxId: string }).sandboxId;
    const row = await waitFor('ready', async () => {
      const x = await lifecycle.get(sandboxId);
      return x?.state === 'ready' ? x : undefined;
    });
    ids = { sandboxId, userId, runId: body.runId };
    containerId = row.containerId!;
  }, 180_000);

  afterAll(async () => {
    for (const c of open) c.ws.terminate();
    await app?.close();
    if (s) {
      await sweep(await allRowIds(s.h.db));
      await s.h.close();
      await s.pg.stop();
    }
  }, 120_000);

  afterEach(closeAll);

  test('ticket → ready; `echo hi` shows hi', async () => {
    const c = client();
    expect(await c.waitCtl('ready')).toEqual({ t: 'ready' });
    c.ws.send(Buffer.from('echo hi-$((6*7))\r'));
    await c.waitOut(/hi-42/);
  });

  test('the same ticket twice → 4401', async () => {
    const t = ticketFor(ids);
    const a = connect(base, t);
    open.push(a);
    await a.waitCtl('ready');
    const b = connect(base, t);
    expect((await b.closed).code).toBe(4401);
    expect(b.ctl).toEqual([]);
  });

  test('a third connection → 4409', async () => {
    const a = client();
    const b = client();
    await Promise.all([a.waitCtl('ready'), b.waitCtl('ready')]);
    const c = client();
    expect((await c.closed).code).toBe(4409);
    expect(c.ctl).toEqual([]);
  });

  test('resize cols=10 is ignored, cols=120 resizes the exec', async () => {
    const c = client();
    await c.waitCtl('ready');
    driver.resizes.length = 0;
    c.sendCtl({ t: 'resize', cols: 10, rows: 30 });
    c.sendCtl({ t: 'resize', cols: 120, rows: 30 });
    await waitFor('resize', async () => driver.resizes.length > 0);
    await sleep(200);
    expect(driver.resizes).toEqual([[120, 30]]);
    c.ws.send(Buffer.from('stty size\r'));
    // The pane is the window minus tmux's status line.
    await c.waitOut(/\b\d+ 120\b/);
  });

  test('ping → pong', async () => {
    const c = client();
    await c.waitCtl('ready');
    c.sendCtl({ t: 'ping' });
    await c.waitCtl('pong');
  });

  test('three 4 KB frames all arrive (12 KB); a 4097-byte frame is dropped', async () => {
    const c = client();
    await c.waitCtl('ready');
    c.ws.send(Buffer.from('clear; echo start-$((1+1)); wc -c\r'));
    await c.waitOut(/start-2/);
    await sleep(300);
    // 64 lines of 63 'x' + LF = 4096 bytes per frame (the tty's line buffer stays small).
    const frame = Buffer.from(`${'x'.repeat(63)}\n`.repeat(64));
    expect(frame.length).toBe(4096);
    for (let i = 0; i < 3; i++) c.ws.send(frame);
    c.ws.send(Buffer.concat([frame, Buffer.from('\n')]));
    await sleep(300);
    c.ws.send(Buffer.from([4])); // ^D: end of wc's input
    await c.waitOut(/\b12288\b/);
    expect(c.out()).not.toMatch(/\b16385\b/);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  test('a reconnect after a drop sees the same tmux session with its history', async () => {
    const a = client();
    await a.waitCtl('ready');
    a.ws.send(Buffer.from('clear; echo mark-$((1000+234))\r'));
    await a.waitOut(/mark-1234/);
    // A network drop: no close handshake.
    a.ws.terminate();
    open.splice(open.indexOf(a), 1);
    await waitFor('no connections', async () => app.terminals.count(ids.sandboxId) === 0);
    // Only our own tmux client was detached; the session lives on.
    await waitFor(
      'client detached',
      async () => (await tmux('tmux list-clients | wc -l')).trim() === '0',
    );
    expect(await tmux('tmux has-session -t main && echo yes')).toContain('yes');

    const b = client();
    await b.waitCtl('ready');
    await b.waitOut(/mark-1234/);
    expect(await tmux('tmux capture-pane -p -t main -S -')).toContain('mark-1234');
    expect((await tmux('tmux list-sessions | wc -l')).trim()).toBe('1');
  });

  test('DELETE {reason: stopped_by_user} → {t:closed} and code 4002', async () => {
    const c = client();
    await c.waitCtl('ready');
    const r = await app.inject({
      method: 'DELETE',
      url: `/internal/sandboxes/${ids.sandboxId}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { reason: 'stopped_by_user' },
    });
    expect(r.statusCode).toBe(204);
    const done = await c.closed;
    expect(c.ctl.at(-1)).toEqual({ t: 'closed', reason: 'stopped_by_user' });
    expect(done.code).toBe(4002);
    // The sandbox is no longer ready: a new ticket is refused.
    const d = client();
    expect((await d.closed).code).toBe(4401);
  });
});
