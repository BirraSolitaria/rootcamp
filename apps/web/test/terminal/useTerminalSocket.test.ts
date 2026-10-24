import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toWsUrl, useTerminalSocket } from '../../src/terminal/useTerminalSocket';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  closedWith: number | undefined;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // server side
  accept() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  ctl(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
  output(bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer } as MessageEvent);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '', wasClean: code !== 1006 } as CloseEvent);
  }
  get pending() {
    return this.readyState === 0 && this.closedWith === undefined;
  }
  get ctlSent() {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as unknown);
  }
}

const last = () => FakeWebSocket.instances.at(-1)!;
const count = () => FakeWebSocket.instances.length;

let n = 0;
const getTicket = vi.fn(async () => ({ url: `/ws/terminal?ticket=t${++n}` }));

function setup() {
  const onData = vi.fn();
  const onCtl = vi.fn();
  const hook = renderHook(() => useTerminalSocket({ getTicket, onData, onCtl }));
  return { ...hook, onData, onCtl };
}

/** Lets pending promises (getTicket) settle and moves fake time forward. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function serverReady() {
  await act(async () => {
    last().accept();
    last().ctl({ t: 'ready' });
  });
}

async function connected() {
  const r = setup();
  await advance(0);
  await serverReady();
  return r;
}

/** The server is unreachable: whatever attempt is in flight fails. */
async function failPending() {
  if (count() > 0 && last().pending) await act(async () => last().drop(1006));
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  n = 0;
  getTicket.mockClear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toWsUrl', () => {
  it('turns the relative ticket url into ws(s):// on the page host', () => {
    expect(toWsUrl('/ws/terminal?ticket=a', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws/terminal?ticket=a',
    );
    expect(toWsUrl('/ws/terminal?ticket=a', { protocol: 'https:', host: 'rootcamp.ru' })).toBe(
      'wss://rootcamp.ru/ws/terminal?ticket=a',
    );
    expect(toWsUrl('wss://x.example/ws', { protocol: 'http:', host: 'h' })).toBe(
      'wss://x.example/ws',
    );
  });
});

describe('useTerminalSocket', () => {
  it('connects with a ticket, becomes open on ready and passes frames through', async () => {
    const { result, onData, onCtl } = setup();
    expect(result.current.state).toBe('connecting');
    await advance(0);
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(last().url).toBe(`ws://${window.location.host}/ws/terminal?ticket=t1`);
    expect(last().binaryType).toBe('arraybuffer');

    await serverReady();
    expect(result.current.state).toBe('open');
    expect(onCtl).toHaveBeenCalledWith({ t: 'ready' });

    await act(async () => last().output([0x68, 0x69]));
    expect(onData).toHaveBeenCalledWith(new Uint8Array([0x68, 0x69]));

    await act(async () => last().ctl({ t: 'expiring', secondsLeft: 60 }));
    expect(onCtl).toHaveBeenLastCalledWith({ t: 'expiring', secondsLeft: 60 });

    // garbage control frames are ignored
    await act(async () => last().onmessage?.({ data: '{"t":"nope"}' } as MessageEvent));
    await act(async () => last().onmessage?.({ data: 'not json' } as MessageEvent));
    expect(onCtl).toHaveBeenCalledTimes(2);
  });

  it('sends input chunked to 4 KB and control frames as JSON', async () => {
    const { result } = await connected();
    act(() => result.current.sendInput('x'.repeat(9000)));
    // not `instanceof`: jsdom's TextEncoder returns a Uint8Array of another realm
    const bins = last().sent.filter((d): d is Uint8Array => typeof d !== 'string');
    expect(bins.map((b) => b.length)).toEqual([4096, 4096, 808]);

    act(() => result.current.sendCtl({ t: 'resize', cols: 80, rows: 24 }));
    expect(last().ctlSent).toContainEqual({ t: 'resize', cols: 80, rows: 24 });
  });

  it('drops input while not open', async () => {
    const { result } = setup();
    await advance(0);
    expect(result.current.sendInput('ls\r')).toBe(false);
    expect(last().sent).toEqual([]);
  });

  it('pings every 20 s', async () => {
    await connected();
    await advance(20_000);
    expect(last().ctlSent).toEqual([{ t: 'ping' }]);
    await act(async () => last().ctl({ t: 'pong' }));
    await advance(20_000);
    expect(last().ctlSent).toEqual([{ t: 'ping' }, { t: 'ping' }]);
  });

  it('reconnects with a fresh ticket when no pong arrives for 45 s', async () => {
    const { result } = await connected();
    const first = last();
    await advance(20_000);
    await act(async () => first.ctl({ t: 'pong' }));
    await advance(44_000); // 44 s since the last pong: still fine
    expect(first.closedWith).toBeUndefined();
    await advance(1_000);
    expect(first.closedWith).toBeDefined();
    expect(result.current.state).toBe('reconnecting');
    await advance(1_000);
    expect(count()).toBe(2);
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(last().url).toContain('ticket=t2');
  });

  it('after a drop retries after 1, 2, 4, 8, 15 s with a new ticket each time', async () => {
    const { result } = await connected();
    await act(async () => last().drop(1006));
    expect(result.current.state).toBe('reconnecting');

    const failAfter = async (ms: number, expected: number) => {
      await advance(ms - 1);
      expect(count()).toBe(expected - 1);
      await advance(1);
      expect(count()).toBe(expected);
      await failPending();
    };
    await failAfter(1_000, 2);
    await failAfter(2_000, 3);
    await failAfter(4_000, 4);
    await failAfter(8_000, 5);
    await failAfter(15_000, 6);
    await failAfter(15_000, 7); // the delay stays at 15 s
    expect(getTicket).toHaveBeenCalledTimes(7);
    expect(new Set(FakeWebSocket.instances.map((w) => w.url)).size).toBe(7);
    expect(result.current.state).toBe('reconnecting');
  });

  it('is lost 2 min after the drop, not earlier, and then stops trying', async () => {
    const { result } = await connected();
    await act(async () => last().drop(1006));
    for (let t = 0; t < 119; t++) {
      await advance(1_000);
      await failPending();
    }
    expect(result.current.state).toBe('reconnecting');
    for (let t = 0; t < 2; t++) {
      await advance(1_000);
      await failPending();
    }
    expect(result.current.state).toBe('lost');
    const attempts = count();
    await advance(10 * 60_000);
    expect(count()).toBe(attempts);
  });

  it('a successful reconnect resets the backoff', async () => {
    const { result } = await connected();
    await act(async () => last().drop(1006));
    await advance(1_000);
    await failPending();
    await advance(2_000);
    await serverReady();
    expect(result.current.state).toBe('open');
    await act(async () => last().drop(1000)); // the shell exited
    expect(result.current.state).toBe('reconnecting');
    await advance(1_000);
    expect(count()).toBe(4);
  });

  it('does not reconnect after {t:closed}', async () => {
    const { result, onCtl } = await connected();
    await act(async () => {
      last().ctl({ t: 'closed', reason: 'expired' });
      last().drop(4000);
    });
    expect(onCtl).toHaveBeenLastCalledWith({ t: 'closed', reason: 'expired' });
    expect(result.current.state).toBe('closed');
    expect(result.current.closedReason).toBe('expired');
    await advance(5 * 60_000);
    expect(count()).toBe(1);
    expect(getTicket).toHaveBeenCalledTimes(1);
  });

  it('treats 4000–4008 as final even without the closed frame', async () => {
    const { result } = await connected();
    await act(async () => last().drop(4006));
    expect(result.current.state).toBe('closed');
    expect(result.current.closedReason).toBe('solved');
    await advance(60_000);
    expect(count()).toBe(1);
  });

  it('4409 (too many connections) is final', async () => {
    const { result } = setup();
    await advance(0);
    await act(async () => last().drop(4409));
    expect(result.current.state).toBe('closed');
    expect(result.current.closedReason).toBe('too_many');
    await advance(60_000);
    expect(count()).toBe(1);
  });

  it('4401 (ticket refused) and 4100 (silence) retry with a new ticket', async () => {
    const { result } = setup();
    await advance(0);
    await act(async () => last().drop(4401));
    expect(result.current.state).toBe('reconnecting');
    await advance(1_000);
    expect(getTicket).toHaveBeenCalledTimes(2);
    await serverReady();
    await act(async () => last().drop(4100));
    await advance(1_000);
    expect(getTicket).toHaveBeenCalledTimes(3);
  });

  it('a failing ticket request counts as a failed attempt', async () => {
    getTicket.mockRejectedValueOnce(new Error('409'));
    const { result } = setup();
    await advance(0);
    expect(count()).toBe(0);
    expect(result.current.state).toBe('reconnecting');
    await advance(1_000);
    expect(count()).toBe(1);
  });

  it('an attempt that hangs is abandoned after 10 s', async () => {
    const { result } = setup();
    await advance(0);
    const hung = last();
    await advance(10_000);
    expect(hung.closedWith).toBeDefined();
    expect(result.current.state).toBe('reconnecting');
    await advance(1_000);
    expect(count()).toBe(2);
  });

  it('reconnect() starts over from lost', async () => {
    const { result } = setup();
    await advance(0);
    for (let i = 0; i < 200 && result.current.state !== 'lost'; i++) {
      await failPending();
      await advance(1_000);
    }
    expect(result.current.state).toBe('lost');
    const before = count();
    act(() => result.current.reconnect());
    expect(result.current.state).toBe('connecting');
    await advance(0);
    expect(count()).toBe(before + 1);
    await serverReady();
    expect(result.current.state).toBe('open');
  });

  it('closes the socket and stops retrying on unmount', async () => {
    const { unmount } = await connected();
    const ws = last();
    unmount();
    expect(ws.closedWith).toBe(1000);
    await advance(60_000);
    expect(count()).toBe(1);
  });
});
